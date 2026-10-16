'use strict';

const mongoose = require('mongoose');
const { SYNC_BATCH_STATUS, SYNC_RECORD_RESULT, SYNC_ENTITIES } = require('../../config/constants');

/**
 * The receipt for one synchronisation push.
 *
 * The concept note's hard requirement is that no field data is ever lost
 * (§4d). Persisting a batch — including the per-record outcome and the raw
 * payload of anything rejected — means a record that failed validation can be
 * recovered and repaired from the server side, instead of living only on a
 * tablet that may be wiped or lost.
 *
 * `clientBatchId` makes replays safe: a device that never saw our response
 * re-sends the batch and gets the original result back rather than creating
 * duplicates.
 */

const recordResultSchema = new mongoose.Schema(
  {
    clientRecordId: { type: String, required: true },
    entity: { type: String, enum: Object.values(SYNC_ENTITIES), required: true },
    result: { type: String, enum: Object.values(SYNC_RECORD_RESULT), required: true },
    serverId: { type: mongoose.Schema.Types.ObjectId },
    blueId: String,
    tempReference: String,
    message: String,
    /**
     * Validation issues, so the device can show the enumerator what to fix.
     * Named `validationErrors` rather than `errors`, which Mongoose reserves.
     */
    validationErrors: [{ field: String, message: String }],
    duplicateOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Fisherman' },
    duplicateScore: Number,
  },
  { _id: false }
);

const syncBatchSchema = new mongoose.Schema(
  {
    clientBatchId: { type: String, required: true, unique: true, index: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', index: true },
    deviceCode: String,
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    direction: { type: String, enum: ['PUSH', 'PULL'], default: 'PUSH', index: true },
    status: {
      type: String,
      enum: Object.values(SYNC_BATCH_STATUS),
      default: SYNC_BATCH_STATUS.RECEIVED,
      index: true,
    },

    counts: {
      submitted: { type: Number, default: 0 },
      created: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      duplicatesIgnored: { type: Number, default: 0 },
      flaggedDuplicates: { type: Number, default: 0 },
      conflicts: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },

    results: { type: [recordResultSchema], default: [] },

    /**
     * Raw payload of rejected records only. Accepted records already live in
     * their own collections, so storing those again would duplicate personal
     * data for no benefit.
     */
    rejectedPayloads: { type: [mongoose.Schema.Types.Mixed], default: [], select: false },

    appVersion: String,
    networkType: String,
    /** Device-reported window the batch was captured in. */
    capturedFrom: Date,
    capturedTo: Date,

    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
    durationMs: Number,
    error: String,

    requestId: String,
    ipAddress: String,
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

syncBatchSchema.index({ device: 1, createdAt: -1 });
syncBatchSchema.index({ status: 1, createdAt: -1 });

syncBatchSchema.methods.complete = function complete(status) {
  this.status = status;
  this.completedAt = new Date();
  this.durationMs = this.completedAt.getTime() - this.startedAt.getTime();
  return this;
};

module.exports = mongoose.model('SyncBatch', syncBatchSchema);
