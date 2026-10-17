'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * The register itself.
 *
 * WHAT MOVED OUT OF THE SCHEMA AND INTO THE OPEN
 *
 * The Mongoose model carried pre-save hooks that derived the matching keys —
 * normalised phone, blind-indexed NIN, phonetic name, birth year — and a
 * `select: false` that hid the encrypted NIN. Both were invisible at the call
 * site: a service could not tell by reading itself whether the keys it
 * depended on had been computed. Here `derive()` is called explicitly by
 * `create` and `update`, and the NIN is only ever selected by a query that
 * says so.
 *
 * WHAT THE DATABASE NOW GUARANTEES INSTEAD OF THE APPLICATION
 *
 *   blue_id             unique when present, so verification cannot issue a
 *                       number twice even under concurrent sync
 *   client_record_id    unique when present, so a replayed batch is a no-op
 *   verification_token  unique, so two cards cannot resolve to one record
 *   search_vector       maintained by Postgres, so a write path that forgets
 *                       to reindex is not a possible bug
 *
 * SCOPE. Every list and lookup takes the caller's scope and merges it into
 * the WHERE clause. It is a parameter rather than something a service
 * remembers to apply, because a forgotten scope filter is a cross-LGA data
 * leak that returns a 200.
 */

const TABLE = 'fishermen';

const COLUMNS = [
  'id', 'blue_id', 'temp_reference', 'first_name', 'middle_name', 'last_name',
  'full_name', 'alias', 'gender', 'date_of_birth', 'estimated_year_of_birth',
  'photo', 'phone', 'alt_phone', 'nin_encrypted',
  'next_of_kin_name', 'next_of_kin_phone', 'next_of_kin_relationship',
  'lga', 'community_id', 'community_name', 'landing_site', 'address', 'ward',
  'latitude', 'longitude', 'location_accuracy_m',
  'fisherman_types', 'fishing_types', 'years_fishing', 'is_full_time',
  'secondary_occupation', 'estimated_monthly_catch_kg',
  'cooperative_id', 'cooperative_name', 'cooperative_membership_no', 'cooperative_joined_at',
  'status', 'status_reason', 'status_changed_at', 'status_changed_by',
  'verified_by', 'verified_at', 'verification_notes',
  'merged_into', 'client_record_id', 'registration_channel', 'registered_by',
  'device_id', 'captured_at', 'synced_at', 'client_revision',
  'normalized_phone', 'normalized_alt_phone', 'nin_index', 'normalized_name',
  'phonetic_name', 'birth_year', 'photo_hash',
  'verification_token', 'qr_version', 'id_card_issued_at', 'id_card_issued_by',
  'notes', 'tags', 'is_deleted', 'deleted_at', 'deleted_by',
  'created_at', 'updated_at',
];

const ALIASES = {
  community_id: 'community',
  device_id: 'device',
  nin_encrypted: 'nin',
};

/**
 * The default projection.
 *
 * `nin_encrypted` is absent, and so are the matching keys — they are derived
 * values of no use to a client and, in the blind index's case, a thing that
 * should not travel. `withSensitive()` is the query that includes the NIN.
 */
const PUBLIC_FIELDS = COLUMNS.filter(
  (c) =>
    ![
      'nin_encrypted', 'normalized_phone', 'normalized_alt_phone', 'nin_index',
      'normalized_name', 'phonetic_name', 'photo_hash',
    ].includes(c)
)
  .map((c) => `f.${c}`)
  .join(', ');

const SENSITIVE_FIELDS = `${PUBLIC_FIELDS}, f.nin_encrypted`;

/** Matching keys, for duplicate detection only. */
const MATCH_FIELDS = `
  f.id, f.blue_id, f.lga, f.community_id, f.first_name, f.last_name, f.status,
  f.normalized_phone, f.normalized_alt_phone, f.nin_index, f.normalized_name,
  f.phonetic_name, f.birth_year, f.photo_hash, f.next_of_kin_phone
`;

const LIVE = 'f.is_deleted = false';

/**
 * Rebuilds the nested shapes the API has always returned, so the portal and
 * the field app do not have to change because the storage did.
 */
function shape(row, { includeMatch = false } = {}) {
  if (!row) return null;
  const out = sql.mapRow(row, { aliases: ALIASES });

  if (row.latitude !== null && row.latitude !== undefined) {
    out.location = {
      type: 'Point',
      coordinates: [row.longitude, row.latitude],
      ...(row.location_accuracy_m != null ? { accuracy: row.location_accuracy_m } : {}),
    };
  }
  delete out.latitude;
  delete out.longitude;
  delete out.locationAccuracyM;

  out.nextOfKin = {
    ...(row.next_of_kin_name ? { name: row.next_of_kin_name } : {}),
    ...(row.next_of_kin_phone ? { phone: row.next_of_kin_phone } : {}),
    ...(row.next_of_kin_relationship ? { relationship: row.next_of_kin_relationship } : {}),
  };
  if (!Object.keys(out.nextOfKin).length) delete out.nextOfKin;
  delete out.nextOfKinName;
  delete out.nextOfKinPhone;
  delete out.nextOfKinRelationship;

  if (row.cooperative_id || row.cooperative_name) {
    out.cooperative = {
      ...(row.cooperative_id ? { id: row.cooperative_id } : {}),
      ...(row.cooperative_name ? { name: row.cooperative_name } : {}),
      ...(row.cooperative_membership_no ? { membershipNumber: row.cooperative_membership_no } : {}),
      ...(row.cooperative_joined_at ? { joinedAt: row.cooperative_joined_at } : {}),
    };
  }
  delete out.cooperativeName;
  delete out.cooperativeMembershipNo;
  delete out.cooperativeJoinedAt;

  if (row.verified_by || row.verified_at) {
    out.verification = {
      ...(row.verified_by ? { verifiedBy: row.verified_by } : {}),
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      ...(row.verification_notes ? { notes: row.verification_notes } : {}),
    };
  }
  delete out.verifiedBy;
  delete out.verifiedAt;
  delete out.verificationNotes;

  if (includeMatch) {
    out.match = {
      normalizedPhone: row.normalized_phone,
      normalizedAltPhone: row.normalized_alt_phone,
      ninIndex: row.nin_index,
      normalizedName: row.normalized_name,
      phoneticName: row.phonetic_name,
      birthYear: row.birth_year,
      photoHash: row.photo_hash,
    };
  }
  for (const k of ['normalizedPhone', 'normalizedAltPhone', 'ninIndex', 'normalizedName', 'phoneticName', 'photoHash']) {
    delete out[k];
  }

  return out;
}

const shapeAll = (rows, options) => rows.map((r) => shape(r, options));

/**
 * Flattens the API's nested shape onto columns, and derives the matching
 * keys. Called by every write, so a record cannot reach the table with the
 * keys that duplicate detection depends on left unset.
 */
function toColumns(data, { derive } = {}) {
  const out = { ...data };

  if (out.location) {
    const [lng, lat] = out.location.coordinates || [];
    out.longitude = lng;
    out.latitude = lat;
    if (out.location.accuracy != null) out.locationAccuracyM = out.location.accuracy;
    delete out.location;
  }

  if (out.nextOfKin) {
    out.nextOfKinName = out.nextOfKin.name;
    out.nextOfKinPhone = out.nextOfKin.phone;
    out.nextOfKinRelationship = out.nextOfKin.relationship;
    delete out.nextOfKin;
  }

  if (out.cooperative) {
    out.cooperativeId = out.cooperative.id;
    out.cooperativeName = out.cooperative.name;
    out.cooperativeMembershipNo = out.cooperative.membershipNumber;
    out.cooperativeJoinedAt = out.cooperative.joinedAt;
    delete out.cooperative;
  }

  if (out.verification) {
    out.verifiedBy = out.verification.verifiedBy;
    out.verifiedAt = out.verification.verifiedAt;
    out.verificationNotes = out.verification.notes;
    delete out.verification;
  }

  if (out.match) {
    Object.assign(out, {
      normalizedPhone: out.match.normalizedPhone,
      normalizedAltPhone: out.match.normalizedAltPhone,
      ninIndex: out.match.ninIndex,
      normalizedName: out.match.normalizedName,
      phoneticName: out.match.phoneticName,
      birthYear: out.match.birthYear,
      photoHash: out.match.photoHash,
    });
    delete out.match;
  }

  // The caller supplies the derivation function, so this module needs no
  // knowledge of encryption or phonetics — and the tests can derive without
  // a key.
  if (typeof derive === 'function') Object.assign(out, derive(out));

  // `full_name` is stored so it can be sorted and exported without
  // recomputing; it is never accepted from a payload.
  const names = [out.firstName, out.middleName, out.lastName].filter(Boolean);
  if (names.length) out.fullName = names.join(' ');

  for (const k of ['id', '_id', 'createdAt', 'updatedAt', 'duplicateFlags']) delete out[k];
  return out;
}

/**
 * Turns a caller's scope into a WHERE fragment.
 *
 * A state-wide role gets no restriction. Everyone else is confined to their
 * LGAs, and an enumerator additionally to records they registered or
 * communities they are posted to. An EMPTY scope matches nothing, which is
 * the safe reading: an officer with no LGA assigned should see no register,
 * not all of it.
 */
function scopeFragment(scope, params) {
  if (!scope || scope.stateWide) return null;

  const clauses = [];
  const lgas = scope.lgas || [];
  const communities = scope.communities || [];

  if (lgas.length) clauses.push(`f.lga = ANY(${params.add(lgas)}::text[])`);
  if (communities.length) clauses.push(`f.community_id = ANY(${params.add(communities)}::uuid[])`);
  if (scope.ownerId) clauses.push(`f.registered_by = ${params.add(scope.ownerId)}`);
  if (scope.cooperativeId) clauses.push(`f.cooperative_id = ${params.add(scope.cooperativeId)}`);

  if (!clauses.length) return 'false';
  return `(${clauses.join(' OR ')})`;
}

// --- Reads -----------------------------------------------------------------

async function findById(id, { client, withSensitive = false, includeDeleted = false, scope } = {}) {
  if (!id) return null;
  const params = new sql.Params();
  const conditions = [`f.id = ${params.add(id)}`];
  if (!includeDeleted) conditions.push(LIVE);
  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);

  const { rows } = await database.query(
    `SELECT ${withSensitive ? SENSITIVE_FIELDS : PUBLIC_FIELDS}
       FROM ${TABLE} f ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return shape(rows[0]);
}

async function findByBlueId(blueId, { client, withSensitive = false, scope } = {}) {
  if (!blueId) return null;
  const params = new sql.Params();
  const conditions = [`f.blue_id = ${params.add(String(blueId).toUpperCase())}`, LIVE];
  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);

  const { rows } = await database.query(
    `SELECT ${withSensitive ? SENSITIVE_FIELDS : PUBLIC_FIELDS}
       FROM ${TABLE} f ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return shape(rows[0]);
}

/** Resolves a scanned QR token. The token is opaque and never the Blue ID. */
async function findByVerificationToken(token, { client } = {}) {
  if (!token) return null;
  const { rows } = await database.query(
    `SELECT ${PUBLIC_FIELDS} FROM ${TABLE} f WHERE f.verification_token = $1 AND ${LIVE}`,
    [token],
    client
  );
  return shape(rows[0]);
}

/** Idempotency lookup for a synced record. */
async function findByClientRecordId(clientRecordId, { client } = {}) {
  if (!clientRecordId) return null;
  const { rows } = await database.query(
    `SELECT ${PUBLIC_FIELDS} FROM ${TABLE} f WHERE f.client_record_id = $1`,
    [clientRecordId],
    client
  );
  return shape(rows[0]);
}

const SORTABLE = {
  createdAt: 'f.created_at',
  updatedAt: 'f.updated_at',
  fullName: 'f.full_name',
  blueId: 'f.blue_id',
  lga: 'f.lga',
  status: 'f.status',
};

/**
 * The register list.
 *
 * `search` accepts a Blue ID, a phone number or a name, and picks the index
 * that fits rather than scanning: an exact Blue ID match, an exact
 * normalised-phone match, or the maintained full-text vector.
 */
async function list(query = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];

  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);

  if (query.lga) conditions.push(`f.lga = ${params.add(query.lga)}`);
  if (query.status) conditions.push(`f.status = ${params.add(query.status)}`);
  if (query.community) conditions.push(`f.community_id = ${params.add(query.community)}`);
  if (query.cooperative) conditions.push(`f.cooperative_id = ${params.add(query.cooperative)}`);
  if (query.gender) conditions.push(`f.gender = ${params.add(query.gender)}`);
  if (query.registeredBy) conditions.push(`f.registered_by = ${params.add(query.registeredBy)}`);
  if (query.fishermanType) conditions.push(`${params.add(query.fishermanType)} = ANY(f.fisherman_types)`);
  if (query.fishingType) conditions.push(`${params.add(query.fishingType)} = ANY(f.fishing_types)`);
  if (query.hasBlueId === true) conditions.push('f.blue_id IS NOT NULL');
  if (query.hasBlueId === false) conditions.push('f.blue_id IS NULL');
  if (query.registeredFrom) conditions.push(`f.created_at >= ${params.add(query.registeredFrom)}`);
  if (query.registeredTo) conditions.push(`f.created_at <= ${params.add(query.registeredTo)}`);

  if (query.search) {
    const term = String(query.search).trim();
    if (query.searchBlueId) {
      conditions.push(`f.blue_id = ${params.add(term.toUpperCase())}`);
    } else if (query.searchPhone) {
      const phone = params.add(query.searchPhone);
      conditions.push(`(f.normalized_phone = ${phone} OR f.normalized_alt_phone = ${phone})`);
    } else if (query.searchNinIndex) {
      conditions.push(`f.nin_index = ${params.add(query.searchNinIndex)}`);
    } else if (term.length >= 2) {
      conditions.push(`f.search_vector @@ plainto_tsquery('simple', ${params.add(term)})`);
    }
  }

  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 25));
  const orderBy = sql.resolveOrderBy(query.sort, SORTABLE, 'f.created_at DESC');

  const { rows } = await database.query(
    `SELECT ${PUBLIC_FIELDS}, count(*) OVER () AS __total
       FROM ${TABLE} f
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
 * Candidates for duplicate scoring.
 *
 * Narrows the register before anything is scored — without this, every
 * registration would scan the whole table, which stops working at tens of
 * thousands of records. An exact NIN or phone hit is decisive enough to
 * search state-wide; a name match is only worth pursuing within the LGA.
 */
async function findDuplicateCandidates(
  { ninIndex, phone, altPhone, photoHash, phoneticName, lga, excludeId },
  { client, limit = 50 } = {}
) {
  const params = new sql.Params();
  const any = [];

  if (ninIndex) any.push(`f.nin_index = ${params.add(ninIndex)}`);
  if (phone) {
    const p = params.add(phone);
    any.push(`(f.normalized_phone = ${p} OR f.normalized_alt_phone = ${p})`);
  }
  if (altPhone) {
    const p = params.add(altPhone);
    any.push(`(f.normalized_phone = ${p} OR f.normalized_alt_phone = ${p})`);
  }
  // A perceptual hash match — the photograph signal the concept note names
  // in §10 and the previous implementation never used.
  if (photoHash) any.push(`f.photo_hash = ${params.add(photoHash)}`);
  if (phoneticName && lga) {
    any.push(`(f.phonetic_name = ${params.add(phoneticName)} AND f.lga = ${params.add(lga)})`);
  }

  if (!any.length) return [];

  const conditions = [LIVE, `(${any.join(' OR ')})`];
  if (excludeId) conditions.push(`f.id <> ${params.add(excludeId)}`);
  // A record already retired into another is not a candidate.
  conditions.push('f.merged_into IS NULL');

  const { rows } = await database.query(
    `SELECT ${MATCH_FIELDS} FROM ${TABLE} f ${sql.where(...conditions)} LIMIT ${Number(limit)}`,
    params.values,
    client
  );
  return shapeAll(rows, { includeMatch: true });
}

/**
 * Keyset page for the field app's sync pull.
 *
 * Keyset, not OFFSET: a record updated during the walk shifts an offset
 * window and silently skips a neighbour, which in this system means a
 * fisherman that never reaches the device.
 *
 * THE CURSOR IS A STRING, AND HAS TO BE.
 *
 * `timestamptz` holds microseconds; a JavaScript Date holds milliseconds.
 * Reading the cursor as a Date and sending it back therefore rounds it DOWN,
 * so `updated_at > cursor` still matches the rows that were just returned —
 * the cursor stops advancing and the device re-pulls the same page forever,
 * never completing a sync and never erroring either. The timestamp is
 * selected as text and compared as text-cast-to-timestamptz so the full
 * precision survives the round trip.
 */
async function pullSince({ since, lastId, limit = 200, lgas }, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];

  if (since) {
    const s = `${params.add(String(since))}::timestamptz`;
    if (lastId) {
      conditions.push(`(f.updated_at, f.id) > (${s}, ${params.add(lastId)}::uuid)`);
    } else {
      conditions.push(`f.updated_at > ${s}`);
    }
  }
  if (lgas?.length) conditions.push(`f.lga = ANY(${params.add(lgas)}::text[])`);

  const { rows } = await database.query(
    `SELECT ${PUBLIC_FIELDS}, f.updated_at::text AS __cursor_updated_at
       FROM ${TABLE} f
      ${sql.where(...conditions)}
      ORDER BY f.updated_at ASC, f.id ASC
      LIMIT ${Number(limit)}`,
    params.values,
    client
  );

  const items = rows.map(({ __cursor_updated_at, ...row }) => shape(row));
  const last = rows[rows.length - 1];

  return {
    items,
    /** Pass this back verbatim as the next call's `since`/`lastId`. */
    cursor: last ? { since: last.__cursor_updated_at, lastId: last.id } : null,
    hasMore: rows.length === Number(limit),
  };
}

async function count(filter = {}, { client, scope } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  const scoped = scopeFragment(scope, params);
  if (scoped) conditions.push(scoped);
  if (filter.lga) conditions.push(`f.lga = ${params.add(filter.lga)}`);
  if (filter.status) conditions.push(`f.status = ${params.add(filter.status)}`);
  if (filter.community) conditions.push(`f.community_id = ${params.add(filter.community)}`);

  return Number(
    await sql.scalar(
      `SELECT count(*) FROM ${TABLE} f ${sql.where(...conditions)}`,
      params.values,
      client
    )
  );
}

// --- Writes ----------------------------------------------------------------

async function create(data, { client, derive } = {}) {
  const { text, values } = sql.buildInsert(TABLE, toColumns(data, { derive }), COLUMNS, {
    aliases: ALIASES,
  });
  const { rows } = await database.query(text, values, client);
  return shape(rows[0]);
}

async function update(id, data, { client, derive } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data, { derive }), COLUMNS, {
    aliases: ALIASES,
  });
  if (!built) return findById(id, { client });
  const { rows } = await database.query(built.text, built.values, client);
  return shape(rows[0]);
}

/**
 * Attaches a Blue ID at verification.
 *
 * Conditional on the record not already having one. Two verifications
 * arriving together therefore cannot both issue: the second matches no rows
 * and the caller is told, instead of quietly overwriting a number that may
 * already be printed on a card.
 */
async function assignBlueId(id, { blueId, verificationToken, verifiedBy }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET blue_id = $2,
            verification_token = $3,
            verified_by = $4,
            verified_at = now(),
            status = 'ACTIVE',
            status_changed_at = now(),
            id_card_issued_at = now(),
            id_card_issued_by = $4
      WHERE id = $1 AND blue_id IS NULL AND is_deleted = false
      RETURNING *`,
    [id, blueId, verificationToken, verifiedBy],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Rotates the QR token when a card is reissued, so a lost card stops
 * resolving. The Blue ID itself is permanent and deliberately untouched.
 */
async function reissueCard(id, { verificationToken, issuedBy }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET verification_token = $2,
            qr_version = qr_version + 1,
            id_card_issued_at = now(),
            id_card_issued_by = $3
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, verificationToken, issuedBy],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

async function changeStatus(id, { status, reason, changedBy }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = $2, status_reason = $3, status_changed_at = now(), status_changed_by = $4
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, status, reason || null, changedBy || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/** Retires one identity into another. The loser is kept, never deleted. */
async function mergeInto(loserId, survivorId, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET merged_into = $2, status = 'DUPLICATE_UNDER_REVIEW', status_changed_at = now()
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [loserId, survivorId],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

async function softDelete(id, { by, reason }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET is_deleted = true, deleted_at = now(), deleted_by = $2, status_reason = $3
      WHERE id = $1 AND is_deleted = false
      RETURNING *`,
    [id, by || null, reason || null],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Optimistic concurrency for sync.
 *
 * A device sends the revision it based its edit on. If the server has moved
 * on, nothing is written and the caller reports a conflict rather than
 * overwriting an edit it never saw.
 */
async function updateIfUnchanged(id, data, expectedRevision, { client, derive } = {}) {
  const columns = toColumns(data, { derive });
  columns.clientRevision = Number(expectedRevision) + 1;

  const built = sql.buildUpdate(TABLE, id, columns, COLUMNS, { aliases: ALIASES });
  if (!built) return { updated: false, reason: 'nothing to update' };

  const guarded = built.text.replace(
    'WHERE id = $' + built.values.length,
    `WHERE id = $${built.values.length} AND client_revision = $${built.values.length + 1}`
  );
  const { rows } = await database.query(guarded, [...built.values, expectedRevision], client);

  if (!rows.length) return { updated: false, reason: 'revision conflict' };
  return { updated: true, record: shape(rows[0]) };
}

/** Test and seed support; bypasses the soft-delete convention deliberately. */
async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.lga) conditions.push(`lga = ${params.add(filter.lga)}`);
  if (filter.clientRecordIdLike) {
    conditions.push(`client_record_id LIKE ${params.add(filter.clientRecordIdLike)}`);
  }
  if (!conditions.length) throw new Error('hardDelete needs a filter');

  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return rowCount;
}

module.exports = {
  TABLE,
  COLUMNS,
  shape,
  toColumns,
  scopeFragment,
  findById,
  findByBlueId,
  findByVerificationToken,
  findByClientRecordId,
  findDuplicateCandidates,
  list,
  pullSince,
  count,
  create,
  update,
  updateIfUnchanged,
  assignBlueId,
  reissueCard,
  changeStatus,
  mergeInto,
  softDelete,
  hardDelete,
};
