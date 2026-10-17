'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Shared behaviour for boats, engines and equipment.
 *
 * The three differ only in their own columns — a boat has a hull length, an
 * engine a serial number, a net a mesh size. Everything else is identical:
 * they belong to a fisherman, they are scoped by LGA, they arrive from a
 * field device with a replay key and a revision, they can be transferred,
 * and they are soft-deleted.
 *
 * Writing that once matters for one reason in particular. The sync cursor
 * has a trap in it: `timestamptz` holds microseconds and a JavaScript Date
 * holds milliseconds, so a cursor that round-trips through a Date rounds
 * DOWN and stops advancing — the device re-pulls the same page forever,
 * with no error to notice. That was found in the fisherman repository. Three
 * more hand-written copies would be three more chances to reintroduce it.
 */

/** Columns every asset table carries. */
const COMMON_COLUMNS = [
  'id', 'owner_id', 'blue_id', 'lga', 'allocation_id', 'photo',
  'condition', 'year_acquired', 'acquisition_source', 'estimated_value',
  'is_active', 'client_record_id', 'registered_by', 'device_id',
  'captured_at', 'synced_at', 'client_revision', 'notes',
  'is_deleted', 'deleted_at', 'created_at', 'updated_at',
];

const COMMON_ALIASES = {
  owner_id: 'owner',
  device_id: 'device',
  allocation_id: 'allocation',
  community_id: 'community',
  boat_id: 'boat',
};

/**
 * Builds a repository for one asset table.
 *
 * `ownColumns` are the columns specific to this kind; `uniqueColumn` is the
 * registration number or serial, which is unique when present and absent on
 * equipment.
 */
function createAssetRepository({ table, ownColumns = [], uniqueColumn = null, label }) {
  const COLUMNS = [...new Set([...COMMON_COLUMNS, ...ownColumns])];
  const ALIASES = COMMON_ALIASES;
  const opts = { aliases: ALIASES };

  const FIELDS = COLUMNS.map((c) => `a.${c}`).join(', ');
  const LIVE = 'a.is_deleted = false';

  function shape(row) {
    if (!row) return null;
    const out = sql.mapRow(row, opts);
    // `specification` and `photo` are JSONB and come back as objects; nothing
    // to reshape, but an absent one should stay absent rather than be null.
    return out;
  }

  const shapeAll = (rows) => rows.map(shape);

  function toColumns(data) {
    const out = { ...data };
    // Accept either the nested or the flat spelling for the foreign keys,
    // because the sync payload and the portal disagree about which they send.
    if (out.owner && typeof out.owner === 'object') out.owner = out.owner.id || out.owner._id;
    if (out.community && typeof out.community === 'object') out.community = out.community.id;
    if (out.boat && typeof out.boat === 'object') out.boat = out.boat.id;
    for (const k of ['id', '_id', 'createdAt', 'updatedAt']) delete out[k];
    return out;
  }

  /** Scope fragment. An empty scope matches nothing, never everything. */
  function scopeFragment(scope, params) {
    if (!scope || scope.stateWide) return null;
    const clauses = [];
    if (scope.lgas?.length) clauses.push(`a.lga = ANY(${params.add(scope.lgas)}::text[])`);
    if (scope.ownerId) clauses.push(`a.registered_by = ${params.add(scope.ownerId)}`);
    if (!clauses.length) return 'false';
    return `(${clauses.join(' OR ')})`;
  }

  // --- Reads ---------------------------------------------------------------

  async function findById(id, { client, includeDeleted = false, scope } = {}) {
    if (!id) return null;
    const params = new sql.Params();
    const conditions = [`a.id = ${params.add(id)}`];
    if (!includeDeleted) conditions.push(LIVE);
    const scoped = scopeFragment(scope, params);
    if (scoped) conditions.push(scoped);

    const { rows } = await database.query(
      `SELECT ${FIELDS} FROM ${table} a ${sql.where(...conditions)}`,
      params.values,
      client
    );
    return shape(rows[0]);
  }

  async function findByClientRecordId(clientRecordId, { client } = {}) {
    if (!clientRecordId) return null;
    const { rows } = await database.query(
      `SELECT ${FIELDS} FROM ${table} a WHERE a.client_record_id = $1`,
      [clientRecordId],
      client
    );
    return shape(rows[0]);
  }

  /** Looks up by registration number or serial, where the kind has one. */
  async function findByUnique(value, { client } = {}) {
    if (!uniqueColumn || !value) return null;
    const { rows } = await database.query(
      `SELECT ${FIELDS} FROM ${table} a WHERE a.${uniqueColumn} = $1 AND ${LIVE}`,
      [value],
      client
    );
    return shape(rows[0]);
  }

  /** Everything one fisherman owns. Drives the Blue ID verification view. */
  async function findByOwner(ownerId, { client, includeInactive = false } = {}) {
    const conditions = ['a.owner_id = $1', LIVE];
    if (!includeInactive) conditions.push('a.is_active = true');
    const { rows } = await database.query(
      `SELECT ${FIELDS} FROM ${table} a ${sql.where(...conditions)} ORDER BY a.created_at DESC`,
      [ownerId],
      client
    );
    return shapeAll(rows);
  }

  const SORTABLE = {
    createdAt: 'a.created_at',
    updatedAt: 'a.updated_at',
    lga: 'a.lga',
    condition: 'a.condition',
    yearAcquired: 'a.year_acquired',
  };

  async function list(query = {}, { client, scope } = {}) {
    const params = new sql.Params();
    const conditions = [LIVE];

    const scoped = scopeFragment(scope, params);
    if (scoped) conditions.push(scoped);

    if (query.owner) conditions.push(`a.owner_id = ${params.add(query.owner)}`);
    if (query.lga) conditions.push(`a.lga = ${params.add(query.lga)}`);
    if (query.blueId) conditions.push(`a.blue_id = ${params.add(String(query.blueId).toUpperCase())}`);
    if (query.condition) conditions.push(`a.condition = ${params.add(query.condition)}`);
    if (query.allocation) conditions.push(`a.allocation_id = ${params.add(query.allocation)}`);
    if (query.isActive !== undefined) conditions.push(`a.is_active = ${params.add(Boolean(query.isActive))}`);

    // Kind-specific filters, applied only where the column exists.
    for (const [key, column] of Object.entries(query.extra || {})) {
      if (!COLUMNS.includes(column) || query[key] === undefined) continue;
      conditions.push(`a.${column} = ${params.add(query[key])}`);
    }

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));
    const orderBy = sql.resolveOrderBy(query.sort, SORTABLE, 'a.created_at DESC');

    const { rows } = await database.query(
      `SELECT ${FIELDS}, count(*) OVER () AS __total
         FROM ${table} a
         ${sql.where(...conditions)}
        ORDER BY ${orderBy}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params.values,
      client
    );

    const total = rows.length ? Number(rows[0].__total) : 0;
    return {
      items: rows.map(({ __total, ...row }) => shape(row)),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 0,
    };
  }

  /**
   * Keyset page for the sync pull.
   *
   * The cursor is a STRING carrying the timestamp at full precision. Reading
   * it back as a JavaScript Date truncates microseconds, which makes the
   * cursor stop advancing and the device re-pull the same page forever —
   * silently. See the note at the top of this file.
   */
  async function pullSince({ since, lastId, limit = 200, lgas }, { client } = {}) {
    const params = new sql.Params();
    const conditions = [];

    if (since) {
      const s = `${params.add(String(since))}::timestamptz`;
      if (lastId) {
        conditions.push(`(a.updated_at, a.id) > (${s}, ${params.add(lastId)}::uuid)`);
      } else {
        conditions.push(`a.updated_at > ${s}`);
      }
    }
    if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

    const { rows } = await database.query(
      `SELECT ${FIELDS}, a.updated_at::text AS __cursor_updated_at
         FROM ${table} a
        ${sql.where(...conditions)}
        ORDER BY a.updated_at ASC, a.id ASC
        LIMIT ${Number(limit)}`,
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

  async function count(filter = {}, { client, scope } = {}) {
    const params = new sql.Params();
    const conditions = [LIVE];
    const scoped = scopeFragment(scope, params);
    if (scoped) conditions.push(scoped);
    if (filter.lga) conditions.push(`a.lga = ${params.add(filter.lga)}`);
    if (filter.owner) conditions.push(`a.owner_id = ${params.add(filter.owner)}`);
    return Number(
      await sql.scalar(
        `SELECT count(*) FROM ${table} a ${sql.where(...conditions)}`,
        params.values,
        client
      )
    );
  }

  /** Counts per LGA, for the dashboard and the capacity report. */
  async function countByLga({ lgas } = {}, { client } = {}) {
    const params = new sql.Params();
    const conditions = [LIVE];
    if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);
    const { rows } = await database.query(
      `SELECT a.lga, count(*)::int AS count
         FROM ${table} a ${sql.where(...conditions)}
        GROUP BY a.lga ORDER BY a.lga`,
      params.values,
      client
    );
    return rows;
  }

  // --- Writes --------------------------------------------------------------

  async function create(data, { client } = {}) {
    const { text, values } = sql.buildInsert(table, toColumns(data), COLUMNS, opts);
    const { rows } = await database.query(text, values, client);
    return shape(rows[0]);
  }

  async function update(id, data, { client } = {}) {
    const built = sql.buildUpdate(table, id, toColumns(data), COLUMNS, opts);
    if (!built) return findById(id, { client });
    const { rows } = await database.query(built.text, built.values, client);
    return shape(rows[0]);
  }

  /** Optimistic concurrency for sync, as on the register. */
  async function updateIfUnchanged(id, data, expectedRevision, { client } = {}) {
    const columns = toColumns(data);
    columns.clientRevision = Number(expectedRevision) + 1;

    const built = sql.buildUpdate(table, id, columns, COLUMNS, opts);
    if (!built) return { updated: false, reason: 'nothing to update' };

    const guarded = built.text.replace(
      `WHERE id = $${built.values.length}`,
      `WHERE id = $${built.values.length} AND client_revision = $${built.values.length + 1}`
    );
    const { rows } = await database.query(guarded, [...built.values, expectedRevision], client);

    if (!rows.length) return { updated: false, reason: 'revision conflict' };
    return { updated: true, record: shape(rows[0]) };
  }

  /**
   * Moves an asset to another owner.
   *
   * The new owner's LGA comes with it, because scope is enforced on the
   * asset's own LGA: leaving the old one behind would hide a transferred
   * boat from the officers who now cover it.
   */
  async function transfer(id, { toOwnerId, toLga, toBlueId }, { client } = {}) {
    const { rows } = await database.query(
      `UPDATE ${table}
          SET owner_id = $2, lga = coalesce($3, lga), blue_id = $4
        WHERE id = $1 AND is_deleted = false
        RETURNING *`,
      [id, toOwnerId, toLga || null, toBlueId || null],
      client
    );
    return rows.length ? shape(rows[0]) : null;
  }

  async function setPhoto(id, photo, { client } = {}) {
    const { rows } = await database.query(
      `UPDATE ${table} SET photo = $2 WHERE id = $1 AND is_deleted = false RETURNING *`,
      [id, photo],
      client
    );
    return rows.length ? shape(rows[0]) : null;
  }

  async function softDelete(id, { reason } = {}, { client } = {}) {
    const { rows } = await database.query(
      `UPDATE ${table}
          SET is_deleted = true, deleted_at = now(), is_active = false,
              notes = coalesce($2, notes)
        WHERE id = $1 AND is_deleted = false
        RETURNING *`,
      [id, reason || null],
      client
    );
    return rows.length ? shape(rows[0]) : null;
  }

  /** Test and seed support; bypasses the soft-delete convention deliberately. */
  async function hardDelete(filter = {}, { client } = {}) {
    const params = new sql.Params();
    const conditions = [];
    if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
    if (filter.owner) conditions.push(`owner_id = ${params.add(filter.owner)}`);
    if (filter.lga) conditions.push(`lga = ${params.add(filter.lga)}`);
    if (filter.clientRecordIdLike) {
      conditions.push(`client_record_id LIKE ${params.add(filter.clientRecordIdLike)}`);
    }
    if (!conditions.length) throw new Error('hardDelete needs a filter');

    const { rowCount } = await database.query(
      `DELETE FROM ${table} ${sql.where(...conditions)}`,
      params.values,
      client
    );
    return rowCount;
  }

  return {
    label,
    TABLE: table,
    COLUMNS,
    shape,
    findById,
    findByClientRecordId,
    findByUnique,
    findByOwner,
    list,
    pullSince,
    count,
    countByLga,
    create,
    update,
    updateIfUnchanged,
    transfer,
    setPhoto,
    softDelete,
    hardDelete,
  };
}

module.exports = { createAssetRepository, COMMON_COLUMNS, COMMON_ALIASES };
