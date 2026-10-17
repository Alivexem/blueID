'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Benefits issued under a programme (concept note §6).
 *
 * THE GUARANTEE THIS TABLE EXISTS FOR
 *
 * "Every benefit issued should be connected to the fisherman's Blue ID.
 * This will allow government to see exactly who received assistance... It
 * should significantly reduce duplication and multiple registrations for
 * the same government intervention."
 *
 * That is enforced by a partial unique index, not by application code:
 *
 *   one_active_allocation_per_programme
 *     UNIQUE (programme_id, fisherman_id) WHERE is_active_allocation
 *
 * So the same person cannot hold two live allocations from one programme
 * however the request arrives — two officers at once, a replayed sync, a
 * retried request. `is_active_allocation` is cleared when an allocation is
 * rejected or revoked, which is what lets a corrected re-issue through
 * without weakening the rule.
 *
 * Nothing here deletes an allocation. A benefit that was issued and then
 * withdrawn is a fact the Ministry needs to keep, so it is marked, never
 * removed.
 */

const TABLE = 'allocations';

const COLUMNS = [
  'id', 'programme_id', 'programme_code', 'programme_type',
  'fisherman_id', 'blue_id', 'fisherman_name', 'lga', 'community_id',
  'item_description', 'quantity', 'value', 'currency',
  'asset_type', 'asset_ref', 'asset_model',
  'status', 'allocated_by', 'allocated_at', 'approved_by', 'approved_at',
  'delivered_at', 'delivered_by', 'acknowledgement',
  'rejection_reason', 'revoked_reason', 'notes',
  'client_record_id', 'device_id', 'is_active_allocation',
  'captured_at', 'synced_at', 'is_deleted', 'deleted_at',
  'created_at', 'updated_at',
];

const ALIASES = {
  programme_id: 'programme',
  fisherman_id: 'fisherman',
  community_id: 'community',
  device_id: 'device',
};
const opts = { aliases: ALIASES };

const LIVE = 'a.is_deleted = false';
const FIELDS = COLUMNS.map((c) => `a.${c}`).join(', ');

/** Statuses that still count against a programme's allocation. */
const ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'DELIVERED'];

const shape = (row) => (row ? sql.mapRow(row, opts) : null);

function toColumns(data) {
  const out = { ...data };
  if (out.programme && typeof out.programme === 'object') out.programme = out.programme.id;
  if (out.fisherman && typeof out.fisherman === 'object') out.fisherman = out.fisherman.id;
  for (const k of ['id', '_id', 'createdAt', 'updatedAt']) delete out[k];
  return out;
}

function scopeFragment(scope, params) {
  if (!scope || scope.stateWide) return null;
  const clauses = [];
  if (scope.lgas?.length) clauses.push(`a.lga = ANY(${params.add(scope.lgas)}::text[])`);
  if (scope.ownerId) clauses.push(`a.allocated_by = ${params.add(scope.ownerId)}`);
  if (!clauses.length) return 'false';
  return `(${clauses.join(' OR ')})`;
}

// --- Reads -----------------------------------------------------------------

async function findById(id, { client, includeDeleted = false, scope } = {}) {
  if (!id) return null;
  const params = new sql.Params();
  const conditions = [`a.id = ${params.add(id)}`];
  if (!includeDeleted) conditions.push(LIVE);
  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);

  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} a ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return shape(rows[0]);
}

async function findByClientRecordId(clientRecordId, { client } = {}) {
  if (!clientRecordId) return null;
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} a WHERE a.client_record_id = $1`,
    [clientRecordId],
    client
  );
  return shape(rows[0]);
}

/** The live allocation a person holds under a programme, if any. */
async function findActiveFor(programmeId, fishermanId, { client } = {}) {
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} a
      WHERE a.programme_id = $1 AND a.fisherman_id = $2
        AND a.is_active_allocation = true AND ${LIVE}`,
    [programmeId, fishermanId],
    client
  );
  return shape(rows[0]);
}

/** One person's full benefit history — the §5 verification view. */
async function findByFisherman(fishermanId, { client, includeInactive = true } = {}) {
  const conditions = ['a.fisherman_id = $1', LIVE];
  if (!includeInactive) conditions.push('a.is_active_allocation = true');
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} a ${sql.where(...conditions)}
      ORDER BY a.allocated_at DESC`,
    [fishermanId],
    client
  );
  return rows.map(shape);
}

const SORTABLE = {
  allocatedAt: 'a.allocated_at',
  createdAt: 'a.created_at',
  status: 'a.status',
  lga: 'a.lga',
};

async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];

  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);

  if (query.programme) conditions.push(`a.programme_id = ${params.add(query.programme)}`);
  if (query.fisherman) conditions.push(`a.fisherman_id = ${params.add(query.fisherman)}`);
  if (query.status) conditions.push(`a.status = ${params.add(query.status)}`);
  if (query.lga) conditions.push(`a.lga = ${params.add(query.lga)}`);
  if (query.blueId) conditions.push(`a.blue_id = ${params.add(String(query.blueId).toUpperCase())}`);
  if (query.from) conditions.push(`a.allocated_at >= ${params.add(query.from)}`);
  if (query.to) conditions.push(`a.allocated_at <= ${params.add(query.to)}`);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));

  const { rows } = await database.query(
    `SELECT ${FIELDS}, count(*) OVER () AS __total
       FROM ${TABLE} a ${sql.where(...conditions)}
      ORDER BY ${sql.resolveOrderBy(query.sort, SORTABLE, 'a.allocated_at DESC')}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params.values,
    client
  );

  const total = rows.length ? Number(rows[0].__total) : 0;
  return {
    items: rows.map(({ __total, ...row }) => shape(row)),
    total, page, limit, pages: Math.ceil(total / limit) || 0,
  };
}

/** Keyset page for sync. Cursor is a string; see fisherman.repository. */
async function pullSince({ since, lastId, limit = 200, lgas }, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];

  if (since) {
    const s = `${params.add(String(since))}::timestamptz`;
    conditions.push(
      lastId
        ? `(a.updated_at, a.id) > (${s}, ${params.add(lastId)}::uuid)`
        : `a.updated_at > ${s}`
    );
  }
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT ${FIELDS}, a.updated_at::text AS __cursor_updated_at
       FROM ${TABLE} a ${sql.where(...conditions)}
      ORDER BY a.updated_at ASC, a.id ASC LIMIT ${Number(limit)}`,
    params.values,
    client
  );

  const last = rows[rows.length - 1];
  return {
    items: rows.map(({ __cursor_updated_at, ...row }) => shape(row)),
    cursor: last ? { since: last.__cursor_updated_at, lastId: last.id } : null,
    hasMore: rows.length === Number(limit),
  };
}

/**
 * Candidates for a programme, with anyone who already holds a live
 * allocation excluded.
 *
 * Done in SQL rather than by loading the register and filtering, because at
 * state-wide scale the eligible set is the smaller side of the join and the
 * exclusion is the whole point.
 */
async function findEligible(programmeId, { lga, status = 'ACTIVE', limit = 100, offset = 0 }, { client } = {}) {
  const params = new sql.Params();
  const conditions = [
    'f.is_deleted = false',
    `f.status = ${params.add(status)}`,
    'f.blue_id IS NOT NULL',
    'f.merged_into IS NULL',
  ];
  if (lga) conditions.push(`f.lga = ${params.add(lga)}`);

  const programme = params.add(programmeId);

  const { rows } = await database.query(
    `SELECT f.id, f.blue_id, f.full_name, f.lga, f.community_id, f.gender,
            f.fisherman_types, f.status,
            count(*) OVER () AS __total
       FROM fishermen f
       ${sql.where(...conditions)}
        AND NOT EXISTS (
          SELECT 1 FROM ${TABLE} a
           WHERE a.programme_id = ${programme}
             AND a.fisherman_id = f.id
             AND a.is_active_allocation = true
             AND a.is_deleted = false
        )
      ORDER BY f.full_name
      LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    params.values,
    client
  );

  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => sql.mapRow(r)), total };
}

/** Has this person already been served by this programme? */
async function hasActiveAllocation(programmeId, fishermanId, { client } = {}) {
  const found = await sql.scalar(
    `SELECT 1 FROM ${TABLE}
      WHERE programme_id = $1 AND fisherman_id = $2
        AND is_active_allocation = true AND is_deleted = false
      LIMIT 1`,
    [programmeId, fishermanId],
    client
  );
  return Boolean(found);
}

// --- Writes ----------------------------------------------------------------

/**
 * Issues a benefit.
 *
 * The caller checks eligibility first for a useful error message, but the
 * index is what actually prevents the double issue — a check-then-insert
 * has a window between the two, and two officers allocating at the same
 * moment is precisely the case this is for. A unique violation here means
 * somebody else got there first, not that the code is wrong.
 */
async function create(data, { client } = {}) {
  const payload = toColumns(data);
  payload.isActiveAllocation = ACTIVE_STATUSES.includes(payload.status || 'PENDING');

  const { text, values } = sql.buildInsert(TABLE, payload, COLUMNS, opts);
  const { rows } = await database.query(text, values, client);
  return shape(rows[0]);
}

/** True when the error is this table's duplicate-benefit index firing. */
function isDuplicateBenefit(err) {
  return err?.code === '23505' && String(err.constraint || '').includes('one_active_allocation');
}

/**
 * Moves an allocation through its lifecycle.
 *
 * `is_active_allocation` is derived from the new status rather than passed
 * in, so it cannot drift from the thing it mirrors — and clearing it on
 * rejection or revocation is what frees the person for a corrected re-issue.
 */
async function changeStatus(id, { status, actorId, reason }, { client } = {}) {
  const active = ACTIVE_STATUSES.includes(status);

  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = $2,
            is_active_allocation = $3,
            approved_by  = CASE WHEN $2 = 'APPROVED'  THEN $4 ELSE approved_by  END,
            approved_at  = CASE WHEN $2 = 'APPROVED'  THEN now() ELSE approved_at END,
            delivered_by = CASE WHEN $2 = 'DELIVERED' THEN $4 ELSE delivered_by END,
            delivered_at = CASE WHEN $2 = 'DELIVERED' THEN now() ELSE delivered_at END,
            rejection_reason = CASE WHEN $2 = 'REJECTED' THEN $5 ELSE rejection_reason END,
            revoked_reason   = CASE WHEN $2 = 'REVOKED'  THEN $5 ELSE revoked_reason   END
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, status, active, actorId || null, reason || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/** Records the proof-of-delivery captured at handover. */
async function recordDelivery(id, { acknowledgement, deliveredBy }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = 'DELIVERED', is_active_allocation = true,
            delivered_at = now(), delivered_by = $3, acknowledgement = $2
      WHERE id = $1 AND is_deleted = false AND status <> 'REVOKED'
      RETURNING *`,
    [id, acknowledgement || null, deliveredBy || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

async function update(id, data, { client } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data), COLUMNS, opts);
  if (!built) return findById(id, { client });
  const { rows } = await database.query(built.text, built.values, client);
  return shape(rows[0]);
}

/**
 * Benefit history is not deletable.
 *
 * Soft delete exists for a record created in error, and it clears the
 * active flag so the person is not left blocked by an allocation that no
 * longer stands. Who received what, and when, stays readable.
 */
async function softDelete(id, { reason } = {}, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET is_deleted = true, deleted_at = now(),
            is_active_allocation = false, notes = coalesce($2, notes)
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, reason || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

// --- Reporting (§7) --------------------------------------------------------

async function summary({ programmeId, lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (programmeId) conditions.push(`a.programme_id = ${params.add(programmeId)}`);
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT count(*)::int                                        AS total,
            count(*) FILTER (WHERE a.status = 'DELIVERED')::int  AS delivered,
            count(*) FILTER (WHERE a.status = 'PENDING')::int    AS pending,
            count(*) FILTER (WHERE a.status = 'APPROVED')::int   AS approved,
            count(*) FILTER (WHERE a.status = 'REJECTED')::int   AS rejected,
            count(*) FILTER (WHERE a.status = 'REVOKED')::int    AS revoked,
            count(DISTINCT a.fisherman_id)::int                  AS unique_beneficiaries,
            coalesce(sum(a.value), 0)                            AS total_value
       FROM ${TABLE} a ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return sql.mapRow(rows[0]);
}

async function countByType({ lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);
  const { rows } = await database.query(
    `SELECT a.programme_type AS type, count(*)::int AS count,
            count(*) FILTER (WHERE a.status = 'DELIVERED')::int AS delivered
       FROM ${TABLE} a ${sql.where(...conditions)}
      GROUP BY a.programme_type ORDER BY count DESC`,
    params.values,
    client
  );
  return rows;
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.programme) conditions.push(`programme_id = ${params.add(filter.programme)}`);
  if (filter.clientRecordIdLike) {
    conditions.push(`client_record_id LIKE ${params.add(filter.clientRecordIdLike)}`);
  }
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client
  );
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, ACTIVE_STATUSES, shape, isDuplicateBenefit,
  findById, findByClientRecordId, findActiveFor, findByFisherman, list, pullSince,
  findEligible, hasActiveAllocation,
  create, update, changeStatus, recordDelivery, softDelete, hardDelete,
  summary, countByType,
};
