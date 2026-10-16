'use strict';

const mongoose = require('mongoose');

/**
 * Transactional outbox / durable job queue.
 *
 * Jobs live in MongoDB, not in Redis. That is a deliberate inversion of the
 * usual pattern and follows the project's central rule: MongoDB is the source
 * of truth and Redis is disposable. If Redis is flushed or restored from an
 * older snapshot, no queued work is lost — a benefit notification, a stats
 * recalculation or a duplicate-review alert is still sitting here, due.
 *
 * It also closes the dual-write gap. A service that updated Mongo and then
 * pushed to Redis could crash between the two and silently drop the job.
 * Instead the job row is written inside the SAME transaction as the business
 * change, so either both land or neither does.
 *
 * Redis still earns its place: it carries the distributed rate limits and the
 * cache. Claiming is done here with an atomic findOneAndUpdate, which is
 * already safe across any number of worker processes.
 */

const outboxSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD'],
      default: 'PENDING',
      index: true,
    },

    /**
     * Idempotency key. A job that must happen at most once (one allocation
     * email, one notification per flag) sets this; the unique index then makes
     * a duplicate enqueue a no-op rather than a second side effect.
     */
    dedupeKey: { type: String },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },

    /** Earliest time this job may run — drives retry backoff and scheduling. */
    runAt: { type: Date, default: Date.now, index: true },

    /** Claim fields. A claim expires so a crashed worker's job is retried. */
    lockedBy: String,
    lockedUntil: { type: Date, index: true },

    lastError: String,
    completedAt: Date,

    /**
     * Non-idempotent side effects already performed by this job.
     *
     * Delivery is at-least-once: a worker that dies after sending an email but
     * before acknowledging will run the job again. `dedupeKey` prevents a
     * duplicate ENQUEUE, but not a duplicate SEND on retry. A handler records
     * the effect here before performing it, and skips it if already present —
     * so a retry re-runs the safe parts without emailing a reviewer twice.
     */
    sideEffects: { type: [String], default: [] },

    /** Correlates a job back to the request that caused it. */
    requestId: String,
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lga: String,
    priority: { type: Number, default: 0, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// The claim query: due, runnable, highest priority first.
outboxSchema.index({ status: 1, runAt: 1, priority: -1 });
// Completed jobs are swept rather than kept forever.
outboxSchema.index({ status: 1, completedAt: 1 });

/**
 * Atomically claims one due job for `workerId`.
 *
 * `findOneAndUpdate` is a single-document atomic operation, so two workers can
 * never claim the same row. An expired `lockedUntil` makes a job claimable
 * again, which is how work is recovered from a worker that died mid-job.
 */
outboxSchema.statics.claimOne = function claimOne(workerId, { lockSeconds = 60 } = {}) {
  const now = new Date();
  return this.findOneAndUpdate(
    {
      runAt: { $lte: now },
      $or: [
        { status: 'PENDING' },
        // Reclaim a job whose worker died holding the lock.
        { status: 'PROCESSING', lockedUntil: { $lt: now } },
      ],
    },
    {
      $set: {
        status: 'PROCESSING',
        lockedBy: workerId,
        lockedUntil: new Date(now.getTime() + lockSeconds * 1000),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { priority: -1, runAt: 1 } }
  );
};

outboxSchema.statics.countPending = function countPending() {
  return this.countDocuments({ status: 'PENDING', runAt: { $lte: new Date() } });
};

outboxSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } }, name: 'outbox_dedupe_key' }
);

module.exports = mongoose.model('OutboxJob', outboxSchema);
