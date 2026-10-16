'use strict';

const mongoose = require('mongoose');

/**
 * Monotonic sequence counters, one document per key (e.g. `blueid:BAK`).
 *
 * Blue ID numbers must be unique, gapless-by-intent and permanent. Deriving
 * the next number from a COUNT of existing fishermen would race under
 * concurrent sync batches and would reuse numbers after a deletion, so the
 * sequence is held here and advanced with a single atomic $inc.
 */
const counterSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false, timestamps: true }
);

/**
 * Atomically reserves and returns the next value for `key`.
 * `findOneAndUpdate` with $inc + upsert is atomic at the document level, so
 * two concurrent callers can never receive the same number.
 */
counterSchema.statics.next = async function next(key, session = null) {
  /**
   * Two concurrent upserts for a counter that does not yet exist can both
   * attempt the insert, and one loses with E11000. That only ever happens on
   * the very first ID issued for an LGA, but "the first Blue ID in Bakassi
   * fails" is not an acceptable failure mode, so the write is retried — by
   * then the document exists and the $inc path is contention-free.
   */
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const query = this.findOneAndUpdate(
        { _id: key },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      if (session) query.session(session);
      const counter = await query.exec();
      return counter.seq;
    } catch (err) {
      const isDuplicateInsert = err?.code === 11000;
      if (!isDuplicateInsert || attempt === MAX_ATTEMPTS) throw err;
      // Brief backoff before the retry; the loser of the insert race only
      // needs the winner's document to be visible.
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
    }
  }

  throw new Error(`Could not allocate a sequence number for ${key}`);
};

/** Reads the current value without consuming one. */
counterSchema.statics.peek = async function peek(key) {
  const counter = await this.findById(key).lean();
  return counter?.seq ?? 0;
};

/**
 * Raises the counter to at least `value` — used after a bulk import of legacy
 * records so freshly issued IDs cannot collide with imported ones.
 */
counterSchema.statics.ensureAtLeast = async function ensureAtLeast(key, value) {
  await this.updateOne({ _id: key, seq: { $lt: value } }, { $set: { seq: value } }, { upsert: true });
};

module.exports = mongoose.model('Counter', counterSchema);
