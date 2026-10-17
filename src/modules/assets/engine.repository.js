'use strict';

const { createAssetRepository } = require('./asset.repository');
const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Outboard engines (concept note §4c).
 *
 * The serial number is the strongest identifier the fisheries department
 * has for a distributed engine, so it is unique when present — it is how a
 * programme proves an engine issued under a grant is the one still in use,
 * and how the same engine registered twice is caught.
 */
const base = createAssetRepository({
  table: 'engines',
  label: 'ENGINE',
  uniqueColumn: 'serial_number',
  ownColumns: [
    'boat_id', 'manufacturer', 'model', 'horsepower', 'serial_number',
    'engine_type', 'fuel_type', 'last_serviced_at',
  ],
});

/** Installed power by LGA — the capacity view behind §14's questions. */
async function horsepowerByLga({ lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = ['a.is_deleted = false', 'a.horsepower IS NOT NULL'];
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT a.lga,
            count(*)::int                       AS engines,
            round(sum(a.horsepower)::numeric, 1) AS total_horsepower,
            round(avg(a.horsepower)::numeric, 1) AS average_horsepower
       FROM engines a ${sql.where(...conditions)}
      GROUP BY a.lga ORDER BY a.lga`,
    params.values,
    client
  );
  return rows.map((r) => sql.mapRow(r));
}

module.exports = { ...base, horsepowerByLga, findBySerialNumber: base.findByUnique };
