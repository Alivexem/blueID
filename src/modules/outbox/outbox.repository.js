'use strict';

const sql = require('../../db/sql');
const database = require('../../config/database');

/**
 * Transactional outbox.
 *
 * Jobs live in the same database as the work that scheduled them, so a job
 * is enqueued inside the transaction that caused it: if the registration
 * rolls back, so does the email about it. A separate queue cannot offer
 * that, which is why this is a table rather than a message broker.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED — the standard way to let several
 * workers share a queue without handing the same job to two of them and
 * without serialising behind a lock.
 */

const TABLE = 'outbox_jobs';

const COLUMNS = [
  'id', 'type', 'payload', 'status', 'dedupe_key', 'attempts', 'max_attempts',
  'run_at', 'locked_by', 'locked_until', 'last_error', 'completed_at',
  'side_effects', 'request_id', 'actor_id', 'lga', 'priority',
  'created_at', 'updated_at',
];

const ALIASES = { actor_id: 'actor' };
const opts = { aliases: ALIASES };
const shape = (row) => (row ? sql.mapRow(row, opts) : null);

/**
 * Enqueues a job, collapsing a repeat of the same work into the one already
 * waiting. `ON CONFLICT DO NOTHING` against the partial unique index means
 * a user who presses the button three times gets one recalculation.
 */
async function enqueue(job, { client } = {}) {
  const row = {
    type: job.type,
    payload: JSON.stringify(job.payload || {}),
    dedupeKey: job.dedupeKey || null,
    maxAttempts: job.maxAttempts || 5,
    runAt: job.runAt || new Date(),
    priority: job.priority || 0,
    requestId: job.requestId || null,
    actorId: job.actor || null,
    lga: job.lga || null,
  };

  const { text, values } = sql.buildInsert(TABLE, row, COLUMNS, opts);
  const guarded = job.dedupeKey
    ? text.replace('RETURNING *', 'ON CONFLICT DO NOTHING RETURNING *')
    : text;

  const { rows } = await database.query(guarded, values, client);
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Takes the next due job.
 *
 * SKIP LOCKED is what makes this safe with more than one worker: a row
 * another worker has locked is passed over rather than waited on, so the
 * same job is never handed out twice and no worker blocks behind another.
 */
async function claimNext({ workerId, leaseSeconds = 300 }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE} SET
        status = 'PROCESSING',
        locked_by = $1,
        locked_until = now() + ($2 || ' seconds')::interval,
        attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ${TABLE}
         WHERE status = 'PENDING' AND run_at <= now()
         ORDER BY priority DESC, run_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [workerId, String(leaseSeconds)], client);
  return rows.length ? shape(rows[0]) : null;
}

async function complete(id, { sideEffects } = {}, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = 'COMPLETED', completed_at = now(), locked_by = NULL,
            locked_until = NULL, side_effects = coalesce($2, side_effects)
      WHERE id = $1 RETURNING *`,
    [id, sideEffects ? JSON.stringify(sideEffects) : null], client);
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Records a failure and schedules a retry, or gives up.
 *
 * Exponential backoff, and DEAD rather than endless retry once the attempts
 * are spent — a job that will never succeed should stop consuming a worker
 * and start being visible to an operator.
 */
async function fail(id, { error, backoffSeconds }, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
            last_error = $2,
            run_at = now() + ($3 || ' seconds')::interval,
            locked_by = NULL, locked_until = NULL
      WHERE id = $1 RETURNING *`,
    // `?? 60`, not `|| 60`: zero is a legitimate backoff — a caller asking
    // for an immediate retry got a silent one-minute delay instead.
    [id, String(error).slice(0, 2000), String(backoffSeconds ?? 60)], client);
  return rows.length ? shape(rows[0]) : null;
}

/**
 * Returns jobs whose lease expired to the queue.
 *
 * A worker killed mid-job leaves the row PROCESSING forever otherwise. The
 * lease is what makes a crash recoverable without anyone intervening.
 */
async function reclaimExpired({ client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = 'PENDING', locked_by = NULL, locked_until = NULL,
            last_error = coalesce(last_error, 'lease expired; worker presumed dead')
      WHERE status = 'PROCESSING' AND locked_until < now()
      RETURNING id, type, attempts`,
    [], client);
  return rows.map((r) => sql.mapRow(r));
}

/**
 * Claims one named side effect on a job, once.
 *
 * A job that crashes after sending an email and before committing will be
 * retried, and the retry must not send the email again. The claim is a
 * conditional array append: exactly one attempt can add the name, so exactly
 * one attempt performs the effect.
 *
 * The marker is written BEFORE the effect deliberately. A missed
 * notification is recoverable by looking at the record; a second official
 * email to a fisherman is not retractable.
 */
async function claimSideEffect(jobId, name, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET side_effects = side_effects || to_jsonb($2::text)
      WHERE id = $1 AND NOT (side_effects @> to_jsonb($2::text))
      RETURNING id`,
    [jobId, name],
    client
  );
  return rows.length > 0;
}

/** Requeues a dead job once the underlying problem has been fixed. */
async function retryDead(jobId, { client } = {}) {
  const { rows } = await database.query(
    `UPDATE ${TABLE}
        SET status = 'PENDING', attempts = 0, run_at = now(),
            last_error = NULL, locked_by = NULL, locked_until = NULL
      WHERE id = $1 AND status = 'DEAD' RETURNING *`,
    [jobId],
    client
  );
  return rows.length ? shape(rows[0]) : null;
}

/** Removes completed jobs past their retention. Keeps the table small. */
async function sweepCompleted({ olderThanDays = 7 } = {}, { client } = {}) {
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE}
      WHERE status = 'COMPLETED' AND completed_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
    client
  );
  return rowCount;
}

/** How many jobs are due right now. */
async function countDue({ client } = {}) {
  return Number(
    await sql.scalar(
      `SELECT count(*) FROM ${TABLE} WHERE status = 'PENDING' AND run_at <= now()`,
      [],
      client
    )
  );
}

async function oldestPending({ client } = {}) {
  const { rows } = await database.query(
    `SELECT id, type, run_at FROM ${TABLE}
      WHERE status = 'PENDING' AND run_at <= now()
      ORDER BY run_at ASC LIMIT 1`,
    [],
    client
  );
  return rows.length ? sql.mapRow(rows[0]) : null;
}

async function stats({ client } = {}) {
  const { rows } = await database.query(
    `SELECT status, count(*)::int AS count,
            min(run_at) FILTER (WHERE status = 'PENDING') AS oldest_due
       FROM ${TABLE} GROUP BY status`, [], client);
  return rows.map((r) => sql.mapRow(r));
}

async function findById(id, { client } = {}) {
  const { rows } = await database.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id], client);
  return shape(rows[0]);
}

async function hardDelete(filter = {}, { client } = {}) {
  const params = new sql.Params();
  const conditions = [];
  if (filter.id) conditions.push(`id = ${params.add(filter.id)}`);
  if (filter.type) conditions.push(`type = ${params.add(filter.type)}`);
  if (filter.dedupeKeyLike) conditions.push(`dedupe_key LIKE ${params.add(filter.dedupeKeyLike)}`);
  if (!conditions.length) throw new Error('hardDelete needs a filter');
  const { rowCount } = await database.query(
    `DELETE FROM ${TABLE} ${sql.where(...conditions)}`, params.values, client);
  return rowCount;
}

module.exports = {
  TABLE, COLUMNS, shape,
  enqueue, claimNext, complete, fail, reclaimExpired, stats, findById, hardDelete,
  claimSideEffect, retryDead, sweepCompleted, countDue, oldestPending,
};
