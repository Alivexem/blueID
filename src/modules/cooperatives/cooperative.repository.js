'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Fishing cooperatives.
 *
 * Membership is a column on the fisherman rather than a join table, because
 * a fisherman belongs to at most one society and the register is read far
 * more often than membership changes. `member_count` is denormalised for the
 * list view and reconciled by a job.
 *
 * Only the last four digits of a bank account are ever stored. A society's
 * full account number is not needed to identify it and would be a liability
 * held in a register that many officers can read.
 */

const TABLE = 'cooperatives';

const COLUMNS = [
  'id', 'name', 'normalized_name', 'registration_number', 'lga',
  'community_id', 'community_name', 'address', 'registered_at',
  'contact_phone', 'contact_email', 'bank_details', 'member_count',
  'is_active', 'is_deleted', 'deleted_at', 'notes', 'created_at', 'updated_at',
];

const ALIASES = { community_id: 'community' };
const opts = { aliases: ALIASES };
const LIVE = 'co.is_deleted = false';
const FIELDS = COLUMNS.map((c) => `co.${c}`).join(', ');

const shape = (row) => (row ? sql.mapRow(row, opts) : null);

function toColumns(data) {
  const out = { ...data };
  if (out.community && typeof out.community === 'object') out.community = out.community.id;
  if (out.name) out.normalizedName = String(out.name).trim().toLowerCase().replace(/\s+/g, '-');
  // Never let a full account number in, whatever the payload says.
  if (out.bankDetails?.accountNumber) {
    out.bankDetails = {
      ...out.bankDetails,
      accountNumberLast4: String(out.bankDetails.accountNumber).slice(-4),
    };
    delete out.bankDetails.accountNumber;
  }
  for (const k of ['id', '_id', 'createdAt', 'updatedAt', 'officers', 'memberCount']) delete out[k];
  return out;
}

async function findById(id, { client, includeDeleted = false } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} co WHERE co.id = $1 ${includeDeleted ? '' : `AND ${LIVE}`}`,
    [id], client);
  return shape(rows[0]);
}

async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (scope && !scope.stateWide) {
    if (scope.cooperativeId) conditions.push(`co.id = ${params.add(scope.cooperativeId)}`);
    else if (scope.lgas?.length) conditions.push(`co.lga = ANY(${params.add(scope.lgas)}::text[])`);
    else conditions.push('false');
  }
  if (query.lga) conditions.push(`co.lga = ${params.add(query.lga)}`);
  if (query.search) conditions.push(`co.name ILIKE ${params.add(`%${query.search}%`)}`);

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));

  const { rows } = await database.query(
    `SELECT ${FIELDS}, count(*) OVER () AS __total FROM ${TABLE} co
      ${sql.where(...conditions)} ORDER BY co.name
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params.values, client);
  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => shape(r)), total, page, limit };
}

async function create(data, { client } = {}) {
  const { text, values } = sql.buildInsert(TABLE, toColumns(data), COLUMNS, opts);
  const { rows } = await database.query(text, values, client);
  return shape(rows[0]);
}

async function update(id, data, { client } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data), COLUMNS, opts);
  if (!built) return findById(id, { client });
  const { rows } = await database.query(built.text, built.values, client);
  return shape(rows[0]);
}

// --- Officers (an embedded array in Mongo; a table here) -------------------

async function listOfficers(cooperativeId, { client } = {}) {
  const { rows } = await database.query(
    `SELECT id, cooperative_id, name, role, phone, created_at
       FROM cooperative_officers WHERE cooperative_id = $1 ORDER BY created_at`,
    [cooperativeId], client);
  return rows.map((r) => sql.mapRow(r, { aliases: { cooperative_id: 'cooperative' } }));
}

async function addOfficer(cooperativeId, { name, role, phone }, { client } = {}) {
  const { rows } = await database.query(
    `INSERT INTO cooperative_officers (cooperative_id, name, role, phone)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [cooperativeId, name, role || null, phone || null], client);
  return sql.mapRow(rows[0], { aliases: { cooperative_id: 'cooperative' } });
}

async function removeOfficer(officerId, { client } = {}) {
  const { rowCount } = await database.query(
    `DELETE FROM cooperative_officers WHERE id = $1`, [officerId], client);
  return rowCount;
}

// --- Membership ------------------------------------------------------------

/** Members, read from the register rather than a second list that could drift. */
async function listMembers(cooperativeId, { client, limit = 200, offset = 0 } = {}) {
  const { rows } = await database.query(
    `SELECT f.id, f.blue_id, f.full_name, f.lga, f.gender, f.status,
            f.cooperative_membership_no, f.cooperative_joined_at,
            count(*) OVER () AS __total
       FROM fishermen f
      WHERE f.cooperative_id = $1 AND f.is_deleted = false
      ORDER BY f.full_name LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [cooperativeId], client);
  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => sql.mapRow(r)), total };
}

/** Reconciles the denormalised count against the register. */
async function recountMembers(cooperativeId, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} co
        SET member_count = (SELECT count(*) FROM fishermen f
                             WHERE f.cooperative_id = $1 AND f.is_deleted = false)
      WHERE co.id = $1 RETURNING co.member_count`,
    [cooperativeId], client);
  return rows.length ? rows[0].member_count : null;
}

async function softDelete(id, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} SET is_deleted = true, deleted_at = now(), is_active = false
      WHERE id = $1 AND is_deleted = false RETURNING *`, [id], client);
  return rows.length ? shape(rows[0]) : null;
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.nameLike) conditions.push(`name LIKE ${params.add(filter.nameLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  findById, list, create, update,
  listOfficers, addOfficer, removeOfficer,
  listMembers, recountMembers,
  softDelete, hardDelete,
};
