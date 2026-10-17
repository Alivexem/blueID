'use strict';

const database = require('../../config/database');

/**
 * The Blue ID sequence.
 *
 * One row per Local Government Area, holding the highest number issued
 * there. `CRS-BLU-BAK-0001` is the first fisherman verified in Bakassi.
 *
 * WHY THIS HAS TO BE ATOMIC
 *
 * A Blue ID is permanent and printed on a card. Two fishermen handed the
 * same number is not a glitch to clean up later — it is two people with one
 * identity in a register that government benefits are allocated against,
 * discovered when the second card is scanned months afterwards.
 *
 * The obvious implementation reads the counter, adds one, and writes it
 * back. Two registrations arriving together both read the same value and
 * both write the same successor. `INSERT ... ON CONFLICT DO UPDATE ...
 * RETURNING` is a single statement: the second waits on the row lock the
 * first holds, then reads the value the first wrote. The sequence cannot
 * hand out a number twice, however many enumerators sync at once.
 *
 * A PostgreSQL SEQUENCE would also be atomic, but sequences are not
 * transactional — a rolled-back registration would burn its number and leave
 * a permanent gap in a numbering scheme the Ministry will read as a count.
 * A counter row rolls back with the transaction that used it.
 */

const TABLE = 'counters';

/**
 * Takes the next number for a key.
 *
 * Must be called inside the same transaction as the registration it numbers,
 * so an abandoned registration gives its number back.
 */
async function next(key, client) {
  const { rows } = await database.query(
    `INSERT INTO ${TABLE} (key, seq) VALUES ($1, 1)
       ON CONFLICT (key) DO UPDATE SET seq = ${TABLE}.seq + 1
     RETURNING seq`,
    [key],
    client
  );
  return rows[0].seq;
}

/** Reads a counter without advancing it. */
async function peek(key, client) {
  const { rows } = await database.query(
    `SELECT seq FROM ${TABLE} WHERE key = $1`,
    [key],
    client
  );
  return rows.length ? rows[0].seq : 0;
}

/**
 * Raises a counter to at least `value`, never lowering it.
 *
 * Used when reconciling after a restore: if the register already holds
 * CRS-BLU-BAK-0042 but the counter says 7 — because a backup predated those
 * registrations — the next issue would collide with an existing card. The
 * `GREATEST` means running this twice, or with a stale value, cannot move
 * the sequence backwards.
 */
async function ensureAtLeast(key, value, client) {
  const floor = Number(value) || 0;
  const { rows } = await database.query(
    `INSERT INTO ${TABLE} (key, seq) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET seq = GREATEST(${TABLE}.seq, EXCLUDED.seq)
     RETURNING seq`,
    [key, floor],
    client
  );
  return rows[0].seq;
}

/** Every counter, for the reconciliation report. */
async function all(client) {
  const { rows } = await database.query(
    `SELECT key, seq, updated_at FROM ${TABLE} ORDER BY key`,
    [],
    client
  );
  return rows.map((r) => ({ key: r.key, seq: r.seq, updatedAt: r.updated_at }));
}

/** Test support only. */
async function reset(key, client) {
  await database.query(`DELETE FROM ${TABLE} WHERE key = $1`, [key], client);
}

module.exports = { TABLE, next, peek, ensureAtLeast, all, reset };
