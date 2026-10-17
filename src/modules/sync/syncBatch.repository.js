'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Sync batches.
 *
 * `client_batch_id` is the replay key: a device that retries a batch — after
 * a timeout, a crash, a lost signal — gets the stored outcome back rather
 * than having the work done twice. §4d is explicit that no information may
 * be lost because connectivity dropped, and a retry that reprocesses is the
 * other half of that failure.
 *
 * `rejected_payloads` keeps what failed validation. A record that an
 * enumerator spent twenty minutes collecting must not vanish because a
 * phone number had a stray character; an administrator can see it and fix it.
 */

const TABLE = 'sync_batches';

const COLUMNS = [
  'id', 'client_batch_id', 'device_id', 'device_code', 'user_id', 'direction',
  'status', 'counts', 'results', 'rejected_payloads', 'app_version',
  'network_type', 'captured_from', 'captured_to', 'started_at',
  'completed_at', 'duration_ms', 'error', 'request_id', 'ip_address',
  'created_at', 'updated_at',
];

const ALIASES = { device_id: 'device', user_id: 'user' };
const opts = { aliases: ALIASES };
/** Rejected payloads hold field data; they are not in the default read. */
const PUBLIC = COLUMNS.filter((c) => c !== 'rejected_payloads').map((c) => `b.${c}`).join(', ');

const shape = (row) => (row ? sql.mapRow(row, opts) : null);

function toColumns(data) {
  const out = { ...data };
  if (out.device && typeof out.device === 'object') out.device = out.device.id;
  if (out.user && typeof out.user === 'object') out.user = out.user.id;
  for (const k of ['id', '_id', 'createdAt', 'updatedAt']) delete out[k];
  return out;
}

async function findByClientBatchId(clientBatchId, { client, withRejected = false } = {}) {
  if (!clientBatchId) return null;
  const { rows } = await database.query(
    `SELECT ${withRejected ? `${PUBLIC}, b.rejected_payloads` : PUBLIC}
       FROM ${TABLE} b WHERE b.client_batch_id = $1`,
    [clientBatchId], client);
  return shape(rows[0]);
}

async function findById(id, { client, withRejected = false } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT ${withRejected ? `${PUBLIC}, b.rejected_payloads` : PUBLIC}
       FROM ${TABLE} b WHERE b.id = $1`, [id], client);
  return shape(rows[0]);
}

/**
 * Claims a batch, or reports that this one has already been handled.
 *
 * The INSERT is the claim: the unique index on client_batch_id means a
 * concurrent retry cannot also claim it. `ON CONFLICT DO NOTHING` turns the
 * race into a readable answer rather than an exception the caller has to
 * interpret.
 */
async function claim(data, { client } = {}) {
  const payload = toColumns({ ...data, status: 'PROCESSING', startedAt: new Date() });
  const { text, values } = sql.buildInsert(TABLE, payload, COLUMNS, opts);
  const guarded = text.replace('RETURNING *', 'ON CONFLICT (client_batch_id) DO NOTHING RETURNING *');

  const { rows } = await database.query(guarded, values, client);
  if (rows.length) return { claimed: true, batch: shape(rows[0]) };

  const existing = await findByClientBatchId(data.clientBatchId, { client });
  return { claimed: false, batch: existing };
}

async function complete(id, { status, counts, results, rejectedPayloads, error, durationMs }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = $2, counts = coalesce($3, counts), results = coalesce($4, results),
            rejected_payloads = coalesce($5, rejected_payloads),
            error = $6, duration_ms = $7, completed_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, counts ? JSON.stringify(counts) : null,
     results ? JSON.stringify(results) : null,
     rejectedPayloads ? JSON.stringify(rejectedPayloads) : null,
     error || null, durationMs || null],
    client);
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Reclaims batches abandoned by a crashed process.
 *
 * Without this a batch left PROCESSING blocks that device forever: the
 * replay key says it is in flight, and nothing is ever going to finish it.
 */
async function reclaimStuck({ olderThanMinutes = 15 } = {}, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = 'FAILED', error = 'abandoned mid-processing and reclaimed',
            completed_at = now()
      WHERE status = 'PROCESSING' AND started_at < now() - ($1 || ' minutes')::interval
      RETURNING id, client_batch_id, device_code`,
    [String(olderThanMinutes)], client);
  return rows.map((r) => sql.mapRow(r));
}

async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (scope && !scope.stateWide && !scope.lgas?.length) conditions.push('false');
  if (query.device) conditions.push(`b.device_id = ${params.add(query.device)}`);
  if (query.status) conditions.push(`b.status = ${params.add(query.status)}`);

  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));
  const { rows } = await database.query(
    `SELECT ${PUBLIC}, count(*) OVER () AS __total FROM ${TABLE} b
      ${sql.where(...conditions)} ORDER BY b.created_at DESC
      LIMIT ${limit} OFFSET ${Number(query.offset) || 0}`,
    params.values, client);
  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => shape(r)), total };
}

/** The payloads that failed validation, for an administrator to inspect. */
async function rejectedPayloads(id, { client } = {}) {
  const { rows } = await database.query(
    `SELECT rejected_payloads FROM ${TABLE} WHERE id = $1`, [id], client);
  return rows.length ? rows[0].rejected_payloads : [];
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.clientBatchIdLike) conditions.push(`client_batch_id LIKE ${params.add(filter.clientBatchIdLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  findById, findByClientBatchId, claim, complete, reclaimStuck,
  list, rejectedPayloads, hardDelete,
};
