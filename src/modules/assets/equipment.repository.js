'use strict';

const { createAssetRepository } = require('./asset.repository');
const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Nets, gear, cold boxes, safety and GPS equipment (concept note §4c).
 *
 * No unique identifier: a fisherman owns six nets and none of them has a
 * serial number. Quantity is a column rather than six rows for that reason,
 * and `specification` is JSONB because a mesh size, a capacity in litres and
 * a brand are not the same attribute wearing different names.
 */
const base = createAssetRepository({
  table: 'equipment',
  label: 'EQUIPMENT',
  uniqueColumn: null,
  ownColumns: ['type', 'description', 'quantity', 'unit', 'specification'],
});

/** Totals by kind, counting quantity rather than rows. */
async function countByType({ lgas } = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = ['a.is_deleted = false'];
  if (lgas?.length) conditions.push(`a.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT a.type,
            count(*)::int            AS records,
            sum(a.quantity)::int     AS units
       FROM equipment a ${sql.where(...conditions)}
      GROUP BY a.type ORDER BY units DESC NULLS LAST`,
    params.values,
    client
  );
  return rows;
}

module.exports = { ...base, countByType };
