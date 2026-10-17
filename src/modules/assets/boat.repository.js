'use strict';

const { createAssetRepository } = require('./asset.repository');
const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Boats and canoes (concept note §4c).
 *
 * `registration_number` is unique when present, not when absent: most
 * artisanal canoes on the Cross River have never been registered with
 * anyone, so requiring a number would stop an enumerator recording the boat
 * that is actually in front of them.
 */
const base = createAssetRepository({
  table: 'boats',
  label: 'BOAT',
  uniqueColumn: 'registration_number',
  ownColumns: [
    'community_id', 'registration_number', 'name', 'boat_type', 'canoe_type',
    'material', 'length_meters', 'width_meters', 'crew_capacity',
    'cargo_capacity_kg', 'propulsion',
  ],
});

/** Fleet composition by hull type — the §7 dashboard tile. */
async function countByType({ lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = ['a.is_deleted = false'];
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT a.boat_type AS type, count(*)::int AS count
       FROM boats a ${sql.where(...conditions)}
      GROUP BY a.boat_type ORDER BY count DESC`,
    params.values,
    client
  );
  return rows;
}

module.exports = { ...base, countByType, findByRegistrationNumber: base.findByUnique };
