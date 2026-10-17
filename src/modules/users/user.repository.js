'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Operator accounts.
 *
 * Replaces the Mongoose model. Three behaviours that used to be implicit in
 * the schema are now explicit here, which is the point of the change — each
 * was something a reader of a service had no way to know was happening:
 *
 *   SELECT LISTS. `passwordHash`, `resetTokenHash`, `failedLoginAttempts`
 *   and `lockedUntil` were `select: false`, so they were absent unless a
 *   caller remembered `+passwordHash`. Here the default projection simply
 *   does not list them, and `withCredentials()` is a different, obviously
 *   named query.
 *
 *   SOFT DELETE. Every read filtered `isDeleted: { $ne: true }` by
 *   convention, and a query that forgot to silently returned removed
 *   accounts. It is now part of the shared WHERE fragment.
 *
 *   FULL NAME. A Mongoose virtual. Now computed in SQL, so it is available
 *   to sorting and searching rather than only after the document loads.
 */

const TABLE = 'users';

/** Column list, used to drop unknown keys before they reach SQL. */
const COLUMNS = [
  'id', 'auth_uid', 'password_hash', 'password_changed_at', 'must_change_password',
  'reset_token_hash', 'reset_token_expires_at', 'failed_login_attempts', 'locked_until',
  'last_login_at', 'last_login_ip', 'email', 'phone', 'first_name', 'last_name',
  'role', 'status', 'scope_lgas', 'scope_communities', 'cooperative_id', 'staff_id',
  'designation', 'invited_by', 'invited_at', 'activated_at', 'last_seen_at',
  'last_device_id', 'is_deleted', 'deleted_at', 'created_at', 'updated_at',
];

/**
 * Column names that differ from their API names by more than case.
 * `cooperative_id` has always been `cooperative` in a response, and renaming
 * it would break the portal for no benefit.
 */
const ALIASES = {
  cooperative_id: 'cooperative',
};

/**
 * The default projection. Credentials are absent by construction rather than
 * by a flag a caller has to remember to leave off.
 *
 * `scope` is rebuilt as the nested object the API has always returned, so
 * `user.scope.lgas` keeps working in the authorization middleware.
 */
const PUBLIC_FIELDS = `
  id, auth_uid, email, phone, first_name, last_name, role, status,
  scope_lgas, scope_communities, cooperative_id, staff_id, designation,
  invited_by, invited_at, activated_at, last_seen_at, last_device_id,
  must_change_password, password_changed_at, last_login_at, last_login_ip,
  is_deleted, deleted_at, created_at, updated_at,
  trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS full_name
`;

const WITH_CREDENTIALS = `
  ${PUBLIC_FIELDS},
  password_hash, reset_token_hash, reset_token_expires_at,
  failed_login_attempts, locked_until
`;

/** Every read excludes removed accounts unless asked otherwise. */
const LIVE = 'is_deleted = false';

/** Rebuilds the nested shapes the rest of the application expects. */
function shape(row) {
  if (!row) return null;
  const user = sql.mapRow(row, { aliases: ALIASES });

  user.scope = {
    lgas: row.scope_lgas || [],
    communities: row.scope_communities || [],
  };
  delete user.scopeLgas;
  delete user.scopeCommunities;

  return user;
}

const shapeAll = (rows) => rows.map(shape);

async function run(text, values, client) {
  const { rows } = await database.query(text, values, client);
  return rows;
}

// --- Reads -----------------------------------------------------------------

async function findById(id, { client, withCredentials = false, includeDeleted = false } = {}) {
  if (!id) return null;
  const fields = withCredentials ? WITH_CREDENTIALS : PUBLIC_FIELDS;
  const rows = await run(
    `SELECT ${fields} FROM ${TABLE} WHERE id = $1 ${includeDeleted ? '' : `AND ${LIVE}`}`,
    [id],
    client
  );
  return shape(rows[0]);
}

async function findByEmail(email, { client, withCredentials = false } = {}) {
  if (!email) return null;
  const fields = withCredentials ? WITH_CREDENTIALS : PUBLIC_FIELDS;
  const rows = await run(
    `SELECT ${fields} FROM ${TABLE} WHERE lower(email) = lower($1) AND ${LIVE}`,
    [email],
    client
  );
  return shape(rows[0]);
}

async function findByAuthUid(authUid, { client } = {}) {
  if (!authUid) return null;
  const rows = await run(
    `SELECT ${PUBLIC_FIELDS} FROM ${TABLE} WHERE auth_uid = $1 AND ${LIVE}`,
    [authUid],
    client
  );
  return shape(rows[0]);
}

/**
 * An invitation waiting to be claimed: created by an administrator, with no
 * provider subject bound yet. Used only by the external-identity modes.
 */
async function findUnclaimedInvitation(email, { client } = {}) {
  if (!email) return null;
  const rows = await run(
    `SELECT ${PUBLIC_FIELDS} FROM ${TABLE}
      WHERE lower(email) = lower($1) AND auth_uid IS NULL AND ${LIVE}`,
    [email],
    client
  );
  return shape(rows[0]);
}

/** Credentials for a sign-in attempt. Separate query, obvious at the call site. */
function findForAuthentication(email, { client } = {}) {
  return findByEmail(email, { client, withCredentials: true });
}

async function findByResetToken(tokenHash, { client } = {}) {
  if (!tokenHash) return null;
  const rows = await run(
    `SELECT ${WITH_CREDENTIALS} FROM ${TABLE} WHERE reset_token_hash = $1 AND ${LIVE}`,
    [tokenHash],
    client
  );
  return shape(rows[0]);
}

/**
 * The administrative list.
 *
 * `scopeLgas` restricts an LGA administrator to staff working in their own
 * areas: `&&` is array overlap, so it matches a user with any LGA in common.
 */
async function list({ page = 1, limit = 25, role, status, lga, search, scopeLgas }, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];

  if (role) conditions.push(`role = ${params.add(role)}`);
  if (status) conditions.push(`status = ${params.add(status)}`);
  if (lga) conditions.push(`${params.add(lga)} = ANY(scope_lgas)`);

  if (search) {
    const term = params.add(`%${search}%`);
    conditions.push(`(first_name ILIKE ${term} OR last_name ILIKE ${term} OR email ILIKE ${term})`);
  }

  if (Array.isArray(scopeLgas)) {
    // An administrator with no LGAs of their own sees nobody, rather than
    // everybody — an empty scope is a restriction, not a wildcard.
    conditions.push(`scope_lgas && ${params.add(scopeLgas)}::text[]`);
  }

  const { rows } = await database.query(
    `SELECT ${PUBLIC_FIELDS}, count(*) OVER () AS __total
       FROM ${TABLE}
       ${sql.where(...conditions)}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`,
    params.values,
    client
  );

  const total = rows.length ? Number(rows[0].__total) : 0;
  const items = rows.map(({ __total, ...row }) => shape(row));
  return { items, total, page: Number(page), limit: Number(limit) };
}

/**
 * Officers who may review a flagged duplicate — used to notify them.
 * Role-based, so it stays correct if the permission table changes.
 */
async function findReviewers({ lga, roles }, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE, `status = 'ACTIVE'`, `role = ANY(${params.add(roles)}::text[])`];
  if (lga) conditions.push(`(${params.add(lga)} = ANY(scope_lgas) OR cardinality(scope_lgas) = 0)`);

  const rows = await run(
    `SELECT ${PUBLIC_FIELDS} FROM ${TABLE} ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return shapeAll(rows);
}

// --- Writes ----------------------------------------------------------------

function toColumns(data) {
  const out = { ...data };

  // The API takes `scope: { lgas, communities }`; the table holds two arrays.
  if (out.scope) {
    if (out.scope.lgas !== undefined) out.scopeLgas = out.scope.lgas;
    if (out.scope.communities !== undefined) out.scopeCommunities = out.scope.communities;
    delete out.scope;
  }
  if (out.email) out.email = String(out.email).toLowerCase().trim();

  // Never settable through a payload: the identifier, the soft-delete flag,
  // and the timestamps the database maintains.
  delete out.id;
  delete out._id;
  delete out.fullName;
  delete out.createdAt;
  delete out.updatedAt;

  return out;
}

async function create(data, { client } = {}) {
  const { text, values } = sql.buildInsert(TABLE, toColumns(data), COLUMNS, { aliases: ALIASES });
  const rows = await run(text, values, client);
  return findById(rows[0].id, { client });
}

async function update(id, data, { client, withCredentials = false } = {}) {
  const built = sql.buildUpdate(TABLE, id, toColumns(data), COLUMNS, { aliases: ALIASES });
  if (!built) return findById(id, { client, withCredentials });
  await run(built.text, built.values, client);
  return findById(id, { client, withCredentials });
}

/**
 * Records a failed sign-in and locks the account past a threshold.
 *
 * One statement rather than read-modify-write: two simultaneous attempts
 * would otherwise each read the same count and write the same increment,
 * letting an attacker run twice the attempts the lockout allows.
 */
async function registerLoginFailure(id, { threshold, lockMinutes }, { client } = {}) {
  const rows = await run(
    `UPDATE ${TABLE}
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_login_attempts, locked_until`,
    [id, threshold, String(lockMinutes)],
    client
  );
  return rows[0] ? sql.mapRow(rows[0]) : null;
}

async function registerLoginSuccess(id, { ip }, { client } = {}) {
  await run(
    `UPDATE ${TABLE}
        SET failed_login_attempts = 0, locked_until = NULL,
            last_login_at = now(), last_login_ip = $2
      WHERE id = $1`,
    [id, ip || null],
    client
  );
}

/** Activity marker, throttled by the caller to one write per 15 minutes. */
async function touch(id, { deviceId }, { client } = {}) {
  await run(
    `UPDATE ${TABLE}
        SET last_seen_at = now(),
            last_device_id = coalesce($2, last_device_id)
      WHERE id = $1`,
    [id, deviceId || null],
    client
  );
}

async function softDelete(id, { by }, { client } = {}) {
  await run(
    `UPDATE ${TABLE} SET is_deleted = true, deleted_at = now() WHERE id = $1`,
    [id],
    client
  );
  return findById(id, { client, includeDeleted: true });
}

/** Test and seed support. Bypasses the soft-delete convention deliberately. */
async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.email) conditions.push(`lower(email) = lower(${params.add(filter.email)})`);
  if (filter.emailLike) conditions.push(`email LIKE ${params.add(filter.emailLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');

  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`,
    params.values,
    client
  );
  return rowCount;
}

async function count(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [LIVE];
  if (filter.role) conditions.push(`role = ${params.add(filter.role)}`);
  if (filter.status) conditions.push(`status = ${params.add(filter.status)}`);
  return Number(
    await sql.scalar(`SELECT count(*) FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client)
  );
}

module.exports = {
  TABLE,
  COLUMNS,
  findById,
  findByEmail,
  findByAuthUid,
  findUnclaimedInvitation,
  findForAuthentication,
  findByResetToken,
  findReviewers,
  list,
  create,
  update,
  registerLoginFailure,
  registerLoginSuccess,
  touch,
  softDelete,
  hardDelete,
  count,
  shape,
};
