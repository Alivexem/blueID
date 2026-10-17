'use strict';

const crypto = require('node:crypto');
const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Refresh sessions.
 *
 * The token itself is never stored — only its SHA-256 — so a dump of this
 * table does not let anyone sign in. Lookups hash the presented token and
 * compare digests.
 *
 * ROTATION AND REUSE. Every refresh mints a new token and retires the one
 * presented, recording which replaced it. A token that has already been
 * rotated turning up again means a copy is in circulation, so the entire
 * family descending from that sign-in is revoked rather than just the one
 * token. That is the difference between noticing a stolen session and
 * handing the thief a fresh credential.
 */

const TABLE = 'sessions';

const COLUMNS = [
  'id', 'user_id', 'token_hash', 'family', 'rotated_at', 'rotated_to',
  'revoked_at', 'revoked_reason', 'expires_at', 'ip_address', 'user_agent',
  'device_code', 'last_used_at', 'created_at', 'updated_at',
];

/** `user_id` has always been `user` in this module's vocabulary. */
const ALIASES = { user_id: 'user' };
const opts = { aliases: ALIASES };

/** SHA-256 of a presented token. The only form that reaches the database. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** A session that can still be used: not revoked, not rotated, not expired. */
const LIVE = 'revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()';

async function create(data, { client } = {}) {
  const payload = { ...data };
  if (payload.user) payload.userId = payload.user;
  delete payload.user;
  delete payload.id;
  delete payload._id;

  const { text, values } = sql.buildInsert(TABLE, payload, COLUMNS, opts);
  return sql.one(text, values, { ...opts, client });
}

function findById(id, { client } = {}) {
  if (!id) return null;
  return sql.one(`SELECT * FROM ${TABLE} WHERE id = $1`, [id], { ...opts, client });
}

/** Looks a session up by the token presented, which is hashed first. */
function findByToken(token, { client } = {}) {
  if (!token) return Promise.resolve(null);
  return sql.one(
    `SELECT * FROM ${TABLE} WHERE token_hash = $1`,
    [hashToken(token)],
    { ...opts, client }
  );
}

/** The caller's own live sessions, so an unfamiliar one can be spotted. */
function listLiveForUser(userId, { client } = {}) {
  return sql.many(
    `SELECT id, user_id, family, expires_at, ip_address, user_agent, device_code,
            last_used_at, created_at
       FROM ${TABLE}
      WHERE user_id = $1 AND ${LIVE}
      ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    [userId],
    { ...opts, client }
  );
}

/**
 * Checks the session named by an access token's `sid`.
 *
 * Read on every authenticated request, so it selects the four columns the
 * decision needs rather than the row. Signing out, changing a password or
 * suspending an account therefore kills outstanding access tokens at their
 * next use instead of leaving them valid until they expire.
 */
async function findUsable(id, userId, { client } = {}) {
  if (!id) return null;
  const { rows } = await database.query(
    `SELECT id, user_id, revoked_at, expires_at
       FROM ${TABLE}
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [id, userId],
    client
  );
  return rows.length ? sql.mapRow(rows[0], opts) : null;
}

/**
 * Rotates a session: retires the presented token and records its successor.
 *
 * Conditional on the row still being live, and returns whether it matched.
 * Two refreshes arriving together therefore cannot both succeed — the loser
 * sees zero rows and is treated as a reuse, which is the correct reading.
 */
async function rotate(id, { nextTokenHash }, { client } = {}) {
  const { rowCount } = await database.query(
    `UPDATE ${TABLE}
        SET rotated_at = now(), rotated_to = $2, last_used_at = now()
      WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL`,
    [id, nextTokenHash],
    client
  );
  return rowCount === 1;
}

async function revoke(id, reason, { client } = {}) {
  const { rowCount } = await database.query(
    `UPDATE ${TABLE}
        SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, reason || null],
    client
  );
  return rowCount;
}

/** Revokes by presented token. Used by sign-out, which may be called twice. */
async function revokeByToken(token, reason, { client } = {}) {
  if (!token) return 0;
  const { rowCount } = await database.query(
    `UPDATE ${TABLE}
        SET revoked_at = now(), revoked_reason = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token), reason || null],
    client
  );
  return rowCount;
}

/**
 * Revokes every session descending from one sign-in.
 *
 * Called when a rotated token is presented again: the whole lineage is
 * suspect, because there is no way to tell which holder is the legitimate
 * one.
 */
async function revokeFamily(family, reason, { client } = {}) {
  const { rowCount } = await database.query(
    `UPDATE ${TABLE}
        SET revoked_at = now(), revoked_reason = $2
      WHERE family = $1 AND revoked_at IS NULL`,
    [family, reason || null],
    client
  );
  return { modifiedCount: rowCount };
}

/** Signs an account out everywhere: password change, suspension, logout-all. */
async function revokeAllForUser(userId, reason, { client, exceptId } = {}) {
  const params = [userId, reason || null];
  let extra = '';
  if (exceptId) {
    params.push(exceptId);
    extra = ' AND id <> $3';
  }
  const { rowCount } = await database.query(
    `UPDATE ${TABLE}
        SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL${extra}`,
    params,
    client
  );
  return { modifiedCount: rowCount };
}

async function touch(id, { client } = {}) {
  await database.query(`UPDATE ${TABLE} SET last_used_at = now() WHERE id = $1`, [id], client);
}

/**
 * Clears sessions that expired some time ago.
 *
 * MongoDB removed these with a TTL index. Postgres has no equivalent, so it
 * is a job — run from the outbox worker. The grace period keeps recently
 * expired rows around, because "your session ended" is a more useful answer
 * than "no such session" when someone asks why they were signed out.
 */
async function purgeExpired({ graceDays = 30 } = {}, { client } = {}) {
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} WHERE expires_at < now() - ($1 || ' days')::interval`,
    [String(graceDays)],
    client
  );
  return rowCount;
}

/** Test and seed support. */
async function hardDelete({ userId }, { client } = {}) {
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} WHERE user_id = $1`,
    [userId],
    client
  );
  return rowCount;
}

module.exports = {
  TABLE,
  hashToken,
  create,
  findById,
  findByToken,
  findUsable,
  listLiveForUser,
  rotate,
  revoke,
  revokeByToken,
  revokeFamily,
  revokeAllForUser,
  touch,
  purgeExpired,
  hardDelete,
};
