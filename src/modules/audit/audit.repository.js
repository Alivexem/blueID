'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * The audit trail (concept note §9).
 *
 * Append-only by design: there is no update and no delete. A trail that can
 * be edited is not a trail, and in a register where benefits are allocated
 * against identities, "who changed this and when" is the only way a dispute
 * is ever settled.
 *
 * `changes` is JSONB because an entry is written once and read whole. The
 * field-level before/after is never queried column by column.
 */

const TABLE = 'audit_logs';

const COLUMNS = [
  'id', 'action', 'actor_user_id', 'actor_name', 'actor_email', 'actor_role',
  'actor_service', 'entity_type', 'entity_id', 'entity_blue_id', 'entity_label',
  'changes', 'metadata', 'lga', 'request_id', 'ip_address', 'user_agent',
  'device_id', 'device_code', 'succeeded', 'failure_reason', 'created_at',
];

const ALIASES = { actor_user_id: 'actorUser', device_id: 'device' };
const opts = { aliases: ALIASES };
const FIELDS = COLUMNS.map((c) => `a.${c}`).join(', ');

function shape(row) {
  if (!row) return null;
  const out = sql.mapRow(row, opts);
  // Rebuild the nested shape the API has always returned.
  out.actor = {
    ...(row.actor_user_id ? { user: row.actor_user_id } : {}),
    ...(row.actor_name ? { name: row.actor_name } : {}),
    ...(row.actor_email ? { email: row.actor_email } : {}),
    ...(row.actor_role ? { role: row.actor_role } : {}),
    ...(row.actor_service ? { service: row.actor_service } : {}),
  };
  out.entity = {
    type: row.entity_type,
    ...(row.entity_id ? { id: row.entity_id } : {}),
    ...(row.entity_blue_id ? { blueId: row.entity_blue_id } : {}),
    ...(row.entity_label ? { label: row.entity_label } : {}),
  };
  out.context = {
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.ip_address ? { ipAddress: row.ip_address } : {}),
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    ...(row.device_code ? { deviceCode: row.device_code } : {}),
  };
  for (const k of ['actorUser', 'actorName', 'actorEmail', 'actorRole', 'actorService',
                   'entityType', 'entityId', 'entityBlueId', 'entityLabel',
                   'requestId', 'ipAddress', 'userAgent', 'deviceCode']) {
    delete out[k];
  }
  return out;
}

/**
 * Writes one entry.
 *
 * Takes an optional client so it can join the transaction it describes: an
 * audit entry for a change that then rolled back would be a record of
 * something that never happened.
 */
async function record(entry, { client } = {}) {
  const row = {
    action: entry.action,
    actorUserId: entry.actor?.user || null,
    actorName: entry.actor?.name || null,
    actorEmail: entry.actor?.email || null,
    actorRole: entry.actor?.role || null,
    actorService: entry.actor?.service || null,
    entityType: entry.entity?.type || 'Unknown',
    entityId: entry.entity?.id || null,
    entityBlueId: entry.entity?.blueId || null,
    entityLabel: entry.entity?.label || null,
    changes: JSON.stringify(entry.changes || []),
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    lga: entry.lga || null,
    requestId: entry.context?.requestId || null,
    ipAddress: entry.context?.ipAddress || null,
    userAgent: entry.context?.userAgent || null,
    deviceId: entry.context?.deviceId || null,
    deviceCode: entry.context?.deviceCode || null,
    succeeded: entry.succeeded !== false,
    failureReason: entry.failureReason || null,
  };

  const { text, values } = sql.buildInsert(TABLE, row, COLUMNS, opts);
  const { rows } = await database.query(text, values, client);
  return shape(rows[0]);
}

async function search(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [];

  if (scope && !scope.stateWide) {
    if (scope.lgas?.length) {
      conditions.push(`(a.lga = ANY(${params.add(scope.lgas)}::text[]) OR a.lga IS NULL)`);
    } else {
      conditions.push('false');
    }
  }
  if (query.action) conditions.push(`a.action = ${params.add(query.action)}`);
  if (query.entityType) conditions.push(`a.entity_type = ${params.add(query.entityType)}`);
  if (query.entityId) conditions.push(`a.entity_id = ${params.add(query.entityId)}`);
  if (query.actor) conditions.push(`a.actor_user_id = ${params.add(query.actor)}`);
  if (query.lga) conditions.push(`a.lga = ${params.add(query.lga)}`);
  if (query.from) conditions.push(`a.created_at >= ${params.add(query.from)}`);
  if (query.to) conditions.push(`a.created_at <= ${params.add(query.to)}`);
  if (query.succeeded !== undefined) conditions.push(`a.succeeded = ${params.add(Boolean(query.succeeded))}`);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));

  const { rows } = await database.query(
    `SELECT ${FIELDS}, count(*) OVER () AS __total FROM ${TABLE} a
      ${sql.where(...conditions)} ORDER BY a.created_at DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params.values, client);
  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => shape(r)), total, page, limit };
}

/** Everything that happened to one record — the history an officer reads. */
async function forEntity(entityType, entityId, { client, limit = 100 } = {}) {
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} a
      WHERE a.entity_type = $1 AND a.entity_id = $2
      ORDER BY a.created_at DESC LIMIT ${Number(limit)}`,
    [entityType, entityId], client);
  return rows.map(shape);
}

/** Enumerator activity — the §7 dashboard panel. */
async function actorActivity({ from, to, lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = ['a.actor_user_id IS NOT NULL'];
  if (from) conditions.push(`a.created_at >= ${params.add(from)}`);
  if (to) conditions.push(`a.created_at <= ${params.add(to)}`);
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT a.actor_user_id, a.actor_name, a.actor_role,
            count(*)::int                                          AS actions,
            count(*) FILTER (WHERE a.action = 'CREATE')::int        AS created,
            count(*) FILTER (WHERE a.succeeded = false)::int        AS failures,
            max(a.created_at)                                      AS last_action_at
       FROM ${TABLE} a ${sql.where(...conditions)}
      GROUP BY a.actor_user_id, a.actor_name, a.actor_role
      ORDER BY actions DESC`,
    params.values, client);
  return rows.map((r) => sql.mapRow(r, opts));
}

async function hardDelete(filter = {}, { client } = {}) {
  // Exists for tests only. Nothing in the application deletes an audit entry.
  const params = new sql.Params();
  const conditions = [];
  if (filter.entityId) conditions.push(`entity_id = ${params.add(filter.entityId)}`);
  if (filter.requestIdLike) conditions.push(`request_id LIKE ${params.add(filter.requestIdLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = { TABLE, COLUMNS, shape, record, search, forEntity, actorActivity, hardDelete };
