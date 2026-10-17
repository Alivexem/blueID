'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Government intervention programmes (concept note §6).
 *
 * Engine distributions, net distributions, fuel subsidies, grants, training.
 * A programme is the thing a benefit is allocated under, and its counters
 * are what the Ministry reads to answer "who received assistance".
 */

const TABLE = 'programmes';

const COLUMNS = [
  'id', 'name', 'code', 'type', 'description', 'year', 'implementing_agency',
  'funding_source', 'status', 'start_date', 'end_date', 'item_description',
  'unit_value', 'currency', 'target_beneficiaries', 'allocated_count',
  'delivered_count', 'total_budget', 'eligibility', 'created_by',
  'approved_by', 'approved_at', 'is_deleted', 'deleted_at',
  'created_at', 'updated_at',
];

const LIVE = 'p.is_deleted = false';
const FIELDS = COLUMNS.map((c) => `p.${c}`).join(', ');

const shape = (row) => (row ? sql.mapRow(row) : null);

function toColumns(data) {
  const out = { ...data };
  if (out.code) out.code = String(out.code).toUpperCase().trim();
  // Counters are maintained by the allocation flow, never by a payload —
  // letting a client set them would let it misreport delivery.
  for (const k of ['id', '_id', 'createdAt', 'updatedAt', 'allocatedCount', 'deliveredCount']) {
    delete out[k];
  }
  return out;
}

async function findById(id, { client, includeDeleted = false } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} p WHERE p.id = $1 ${includeDeleted ? '' : `AND ${LIVE}`}`,
    [id],
    client
  );
  return shape(rows[0]);
}

async function findByCode(code, { client } = {}) {
  if (!code) return null;
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} p WHERE p.code = $1 AND ${LIVE}`,
    [String(code).toUpperCase()],
    client
  );
  return shape(rows[0]);
}

const SORTABLE = {
  createdAt: 'p.created_at',
  year: 'p.year',
  name: 'p.name',
  status: 'p.status',
};

async function list(query = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];

  if (query.status) conditions.push(`p.status = ${params.add(query.status)}`);
  if (query.type) conditions.push(`p.type = ${params.add(query.type)}`);
  if (query.year) conditions.push(`p.year = ${params.add(Number(query.year))}`);
  if (query.search) {
    const term = params.add(`%${query.search}%`);
    conditions.push(`(p.name ILIKE ${term} OR p.code ILIKE ${term})`);
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));

  const { rows } = await database.query(
    `SELECT ${FIELDS}, count(*) OVER () AS __total
       FROM ${TABLE} p ${sql.where(...conditions)}
      ORDER BY ${sql.resolveOrderBy(query.sort, SORTABLE, 'p.year DESC, p.created_at DESC')}
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

async function create(data, { client } = {}) {
  const { text, values } = sql.buildInsert(TABLE, toColumns(data), COLUMNS);
  const { rows } = await database.query(text, values, client);
  return shape(rows[0]);
}

async function update(id, data, { client } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data), COLUMNS);
  if (!built) return findById(id, { client });
  const { rows } = await database.query(built.text, built.values, client);
  return shape(rows[0]);
}

async function changeStatus(id, { status, approvedBy }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = $2,
            approved_by = coalesce($3, approved_by),
            approved_at = CASE WHEN $2 = 'OPEN' AND approved_at IS NULL THEN now() ELSE approved_at END
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, status, approvedBy || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Moves the allocated and delivered counters.
 *
 * Relative (`+ $2`) rather than a recount, so two allocations committing
 * together cannot both read the same total and write the same successor.
 */
async function bumpCounters(id, { allocated = 0, delivered = 0 }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET allocated_count = GREATEST(0, allocated_count + $2),
            delivered_count = GREATEST(0, delivered_count + $3)
      WHERE id = $1
      RETURNING allocated_count, delivered_count`,
    [id, allocated, delivered],
    client
  );
  return rows.length ? sql.mapRow(rows[0]) : null;
}

/**
 * Recomputes the counters from the allocations themselves.
 *
 * The relative updates above are correct under concurrency but drift if a
 * row is ever changed outside the flow — a restore, a manual correction.
 * This is the reconciliation, run as a job rather than on a read path.
 */
async function recountFromAllocations(id, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} p
        SET allocated_count = c.allocated, delivered_count = c.delivered
       FROM (
         SELECT count(*) FILTER (WHERE is_active_allocation)        AS allocated,
                count(*) FILTER (WHERE status = 'DELIVERED')        AS delivered
           FROM allocations
          WHERE programme_id = $1 AND is_deleted = false
       ) c
      WHERE p.id = $1
      RETURNING p.allocated_count, p.delivered_count`,
    [id],
    client
  );
  return rows.length ? sql.mapRow(rows[0]) : null;
}

async function softDelete(id, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} SET is_deleted = true, deleted_at = now()
      WHERE id = $1 AND is_deleted = false RETURNING *`,
    [id],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.codeLike) conditions.push(`code LIKE ${params.add(filter.codeLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client
  );
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  findById, findByCode, list,
  create, update, changeStatus,
  bumpCounters, recountFromAllocations,
  softDelete, hardDelete,
};
