'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Fishing communities (concept note §8).
 *
 * The map the Ministry clicks on. Coordinates are plain latitude/longitude
 * with a GiST index over `ll_to_earth()`, so "what is near here" is an
 * indexed query — see the note in the initial migration about why this is
 * not PostGIS.
 *
 * `facilities` drives the infrastructure-gap reports the brief asks for:
 * which communities lack cold storage, landing sites, boat repair.
 */

const TABLE = 'communities';

const COLUMNS = [
  'id', 'name', 'normalized_name', 'code', 'lga', 'ward', 'type',
  'latitude', 'longitude', 'location_accuracy_m',
  'facilities', 'accessibility', 'estimated_population', 'estimated_fishermen',
  'stats', 'annual_production_kg', 'contact_person', 'development_needs',
  'notes', 'is_active', 'is_deleted', 'deleted_at', 'created_at', 'updated_at',
];

const LIVE = 'c.is_deleted = false';
const FIELDS = COLUMNS.map((x) => `c.${x}`).join(', ');

function shape(row) {
  if (!row) return null;
  const out = sql.mapRow(row);
  if (row.latitude != null) {
    out.location = { type: 'Point', coordinates: [row.longitude, row.latitude] };
  }
  delete out.latitude; delete out.longitude; delete out.locationAccuracyM;
  return out;
}

function toColumns(data) {
  const out = { ...data };
  if (out.location) {
    const [lng, lat] = out.location.coordinates || [];
    out.longitude = lng; out.latitude = lat;
    delete out.location;
  }
  if (out.name) out.normalizedName = String(out.name).trim().toLowerCase().replace(/\s+/g, '-');
  for (const k of ['id', '_id', 'createdAt', 'updatedAt', 'landingSites']) delete out[k];
  return out;
}

async function findById(id, { client, includeDeleted = false } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT ${FIELDS} FROM ${TABLE} c WHERE c.id = $1 ${includeDeleted ? '' : `AND ${LIVE}`}`,
    [id], client
  );
  return shape(rows[0]);
}

async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (scope && !scope.stateWide) {
    if (scope.lgas?.length) conditions.push(`c.lga = ANY(${params.add(scope.lgas)}::text[])`);
    else conditions.push('false');
  }
  if (query.lga) conditions.push(`c.lga = ${params.add(query.lga)}`);
  if (query.type) conditions.push(`c.type = ${params.add(query.type)}`);
  if (query.search) conditions.push(`c.name ILIKE ${params.add(`%${query.search}%`)}`);
  if (query.hasLocation) conditions.push('c.latitude IS NOT NULL');

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));

  const { rows } = await database.query(
    `SELECT ${FIELDS}, count(*) OVER () AS __total FROM ${TABLE} c
      ${sql.where(...conditions)} ORDER BY c.lga, c.name
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params.values, client
  );
  const total = rows.length ? Number(rows[0].__total) : 0;
  return { items: rows.map(({ __total, ...r }) => shape(r)), total, page, limit };
}

/**
 * Communities within a radius.
 *
 * `earth_box` narrows with the index first, then `earth_distance` gives the
 * exact great-circle distance — the box alone is a square and would include
 * corners outside the circle.
 */
async function findNearby({ latitude, longitude, radiusKm = 10, limit = 50 }, { client } = {}) {
  const metres = Number(radiusKm) * 1000;
  const { rows } = await database.query(
    `SELECT ${FIELDS},
            round((earth_distance(ll_to_earth($1, $2), ll_to_earth(c.latitude, c.longitude)) / 1000)::numeric, 2) AS distance_km
       FROM ${TABLE} c
      WHERE ${LIVE} AND c.latitude IS NOT NULL
        AND earth_box(ll_to_earth($1, $2), $3) @> ll_to_earth(c.latitude, c.longitude)
        AND earth_distance(ll_to_earth($1, $2), ll_to_earth(c.latitude, c.longitude)) <= $3
      ORDER BY distance_km ASC LIMIT ${Number(limit)}`,
    [Number(latitude), Number(longitude), metres], client
  );
  return rows.map((r) => ({ ...shape(r), distanceKm: r.distance_km }));
}

/** Communities missing a facility — the §7 infrastructure-gap tiles. */
async function infrastructureGaps({ facility, lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (lgas?.length) conditions.push(`c.lga = ANY(${params.add(lgas)}::text[])`);
  if (facility) conditions.push(`coalesce((c.facilities ->> ${params.add(facility)})::boolean, false) = false`);

  const { rows } = await database.query(
    `SELECT c.id, c.name, c.lga, c.facilities, c.estimated_fishermen,
            c.stats, c.development_needs
       FROM ${TABLE} c ${sql.where(...conditions)}
      ORDER BY coalesce((c.stats ->> 'registeredFishermen')::int, 0) DESC, c.name`,
    params.values, client
  );
  return rows.map((r) => sql.mapRow(r));
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

/**
 * Recomputes the denormalised counts from the register.
 *
 * A job, not a write-path side effect: recomputing on every registration
 * would serialise the sync pipeline behind one row per community.
 */
async function recalculateStats(id, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} c
        SET stats = jsonb_build_object(
              'registeredFishermen', s.fishermen,
              'registeredBoats',     s.boats,
              'registeredEngines',   s.engines,
              'lastRecalculatedAt',  to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSZ'))
       FROM (
         SELECT (SELECT count(*) FROM fishermen f WHERE f.community_id = $1 AND f.is_deleted = false) AS fishermen,
                (SELECT count(*) FROM boats   b WHERE b.community_id = $1 AND b.is_deleted = false) AS boats,
                (SELECT count(*) FROM engines e JOIN fishermen f2 ON f2.id = e.owner_id
                  WHERE f2.community_id = $1 AND e.is_deleted = false) AS engines
       ) s
      WHERE c.id = $1 RETURNING c.stats`,
    [id], client
  );
  return rows.length ? rows[0].stats : null;
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
  if (filter.lga) conditions.push(`lga = ${params.add(filter.lga)}`);
  if (filter.nameLike) conditions.push(`name LIKE ${params.add(filter.nameLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  findById, list, findNearby, infrastructureGaps,
  create, update, recalculateStats, softDelete, hardDelete,
};
