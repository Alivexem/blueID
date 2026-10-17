'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Field devices (concept note §9, "device authentication").
 *
 * A device is a credential, so revoking one has to take effect at the next
 * request rather than whenever a token happens to expire — the status is
 * therefore read on every sync rather than trusted from a claim.
 *
 * `last_sync_cursors` is one cursor PER ENTITY, not one shared cursor. A
 * single cursor across fishermen, boats and allocations silently skipped
 * records: advancing it past a fisherman updated at 10:00 also advanced it
 * past a boat updated at 09:59 that the device had never seen.
 */

const TABLE = 'devices';

const COLUMNS = [
  'id', 'device_code', 'label', 'hardware_id', 'platform', 'model',
  'os_version', 'app_version', 'assigned_to', 'lga', 'communities',
  'status', 'secret_hash', 'last_seen_at', 'last_sync_at',
  'last_sync_cursors', 'stats', 'registered_by', 'revoked_by',
  'revoked_at', 'revoked_reason', 'notes', 'created_at', 'updated_at',
];

const PUBLIC = COLUMNS.filter((c) => c !== 'secret_hash').map((c) => `d.${c}`).join(', ');
const shape = (row) => (row ? sql.mapRow(row) : null);

function toColumns(data) {
  const out = { ...data };
  for (const k of ['id', '_id', 'createdAt', 'updatedAt']) delete out[k];
  return out;
}

async function findById(id, { client, withSecret = false } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT ${withSecret ? `${PUBLIC}, d.secret_hash` : PUBLIC} FROM ${TABLE} d WHERE d.id = $1`,
    [id], client);
  return shape(rows[0]);
}

async function findByCode(deviceCode, { client, withSecret = false } = {}) {
  if (!deviceCode) return null;
  const { rows } = await database.query(
    `SELECT ${withSecret ? `${PUBLIC}, d.secret_hash` : PUBLIC} FROM ${TABLE} d WHERE d.device_code = $1`,
    [deviceCode], client);
  return shape(rows[0]);
}

async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (scope && !scope.stateWide) {
    if (scope.lgas?.length) conditions.push(`d.lga = ANY(${params.add(scope.lgas)}::text[])`);
    else conditions.push('false');
  }
  if (query.status) conditions.push(`d.status = ${params.add(query.status)}`);
  if (query.lga) conditions.push(`d.lga = ${params.add(query.lga)}`);
  if (query.assignedTo) conditions.push(`d.assigned_to = ${params.add(query.assignedTo)}`);

  const { rows } = await database.query(
    `SELECT ${PUBLIC} FROM ${TABLE} d ${sql.where(...conditions)} ORDER BY d.last_seen_at DESC NULLS LAST`,
    params.values, client);
  return rows.map(shape);
}

/**
 * `RETURNING *` would hand back `secret_hash`, which the read projection
 * deliberately hides — a credential must not leak through the one response
 * that happens to use a different code path. Both writes re-read through
 * `findById`, so there is exactly one place that decides what a device
 * looks like to a caller.
 */
async function create(data, { client } = {}) {
  const { text, values } = sql.buildInsert(TABLE, toColumns(data), COLUMNS);
  const { rows } = await database.query(text, values, client);
  return findById(rows[0].id, { client });
}

async function update(id, data, { client } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data), COLUMNS);
  if (!built) return findById(id, { client });
  await database.query(built.text, built.values, client);
  return findById(id, { client });
}

async function revoke(id, { by, reason }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} SET status = 'REVOKED', revoked_at = now(), revoked_by = $2, revoked_reason = $3
      WHERE id = $1 AND status <> 'REVOKED' RETURNING id`,
    [id, by || null, reason || null], client);
  return rows.length ? findById(rows[0].id, { client }) : null;
}

/**
 * Stores one entity's cursor without touching the others.
 *
 * `jsonb_set` rather than replacing the whole object, so two entity pulls
 * finishing together cannot overwrite each other's progress.
 */
async function saveCursor(id, entity, cursor, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET last_sync_cursors = jsonb_set(coalesce(last_sync_cursors, '{}'::jsonb), ARRAY[$2], $3::jsonb, true),
            last_sync_at = now()
      WHERE id = $1 RETURNING last_sync_cursors`,
    [id, entity, JSON.stringify(cursor)], client);
  return rows.length ? rows[0].last_sync_cursors : null;
}

async function touch(id, { client } = {}) {
  await database.query(`UPDATE ${TABLE} SET last_seen_at = now() WHERE id = $1`, [id], client);
}

/** Counters move relatively so concurrent batches do not lose one. */
async function bumpStats(id, { pushed = 0, pulled = 0, batches = 0 }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET stats = jsonb_build_object(
              'recordsPushed',    coalesce((stats->>'recordsPushed')::int, 0) + $2,
              'recordsPulled',    coalesce((stats->>'recordsPulled')::int, 0) + $3,
              'batchesProcessed', coalesce((stats->>'batchesProcessed')::int, 0) + $4,
              'lastBatchAt',      to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'))
      WHERE id = $1 RETURNING stats`,
    [id, pushed, pulled, batches], client);
  return rows.length ? rows[0].stats : null;
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.deviceCodeLike) conditions.push(`device_code LIKE ${params.add(filter.deviceCodeLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  findById, findByCode, list, create, update, revoke,
  saveCursor, touch, bumpStats, hardDelete,
};
